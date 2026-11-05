/**
 * Per-locomotive fuel estimator. Pure: (runtime state, reading, context) →
 * (new state, effects). The worker persists state and applies effects.
 *
 * Why not trust the sensor: tank level sensors read the fuel surface, which
 * sloshes on grades, curves and under acceleration, so raw readings swing by
 * hundreds of gallons. The estimator:
 *  1. predicts the level forward from the throttle notch (the engine burns a
 *     known rate per notch),
 *  2. takes the median of the last five raw readings (rejects spikes),
 *  3. blends the two Kalman-style, trusting the sensor less while the train
 *     accelerates and not at all once the sensor is flagged faulty.
 *
 * Ordering: a reading at or below the last applied sequence number is late (or
 * a duplicate). It is stored for history but never rewinds the estimate. This
 * also makes redelivery after a crash idempotent.
 * @module processor/estimator
 */
import { rateForNotch, IDLE_GAL_PER_HOUR } from '../domain/consumption.js'

export interface Reading {
  locomotiveId: string
  seq: number
  recordedAt: number
  lat: number
  lon: number
  milepost: number
  speedMph: number
  notch: number
  fuelGal: number
  engineState: 'run' | 'idle' | 'off'
}

export interface LocoRuntime {
  lastSeq: number
  lastAt: number
  level: number
  variance: number
  window: number[]
  lastRaw: number
  lastSpeed: number
  lastMilepost: number
  lastNotch: number
  lastEngine: string
  fueling: { startedAt: number; levelBefore: number; milepost: number; lastRiseAt: number } | null
  stationary: { since: number; level: number } | null
  riseStreak: number
  sensorSuspect: boolean
  leakSuspect: boolean
  /** Exponentially decayed sums of filtered burn and forecast burn, for calibration. */
  calActual: number
  calForecast: number
  /** Ticket ids already applied as corrections (idempotency for redelivered corrections). */
  corrections?: string[]
}

/** A fuel-ticket correction, routed through the locomotive's partition so it is ordered with its readings. */
export interface Correction {
  locomotiveId: string
  delta: number
  ticketId: string
}

export interface EstimatorContext {
  capacityGal: number
  reserveGal: number
  /** Forecast burn for this unit between the previous and current milepost (model, planned tonnage, no calibration). */
  forecastGallons: number
  /** Predictable tank-tilt offset on the current grade, removed from the raw reading. */
  tiltGal?: number
}

export type Effect =
  | { kind: 'fueling_completed'; startedAt: number; endedAt: number; levelBefore: number; levelAfter: number; milepost: number }
  | { kind: 'sensor_fault'; jumpGal: number }
  | { kind: 'stationary_loss'; lossGal: number; hours: number }
  | { kind: 'low_fuel'; level: number }
  | { kind: 'fuel_recovered' }

export interface StepResult {
  applied: boolean
  state: LocoRuntime
  smoothed: number | null
  effects: Effect[]
}

/** Process noise (gal² per hour): model error the notch table doesn't capture. */
const Q_PER_HOUR = 2500
const SIGMA_STATIONARY = 25
/** Moving trains slosh constantly on grades and curves. */
const SIGMA_MOVING = 90
const SIGMA_SLOSH = 200
const SIGMA_FAULTY = 10_000
const ACCEL_SLOSH_MPH_PER_MIN = 0.25
const FUELING_JUMP_GAL = 150
const SENSOR_FAULT_JUMP_GAL = 250
const STATIONARY_LOSS_GAL = 60
/** A fueling event ends on departure or after this long with no further rise. */
const FUELING_QUIET_MS = 30 * 60_000
/** Calibration memory: sums decay with distance so recent miles count most. */
const CAL_DECAY_MILES = 300

export function initialRuntime(level: number, seq = -1, at = 0, milepost = 0): LocoRuntime {
  return {
    lastSeq: seq,
    lastAt: at,
    level,
    variance: 100 * 100,
    window: [level],
    lastRaw: level,
    lastSpeed: 0,
    lastMilepost: milepost,
    lastNotch: 0,
    lastEngine: 'idle',
    fueling: null,
    stationary: null,
    riseStreak: 0,
    sensorSuspect: false,
    leakSuspect: false,
    calActual: 0,
    calForecast: 0,
  }
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Forecast gallons a unit must have accumulated before its calibration is trusted (sensor noise is ±30–50 gal). */
export const CAL_MIN_EVIDENCE = 250

export function calibration(state: Pick<LocoRuntime, 'calActual' | 'calForecast'>): number {
  return state.calForecast > CAL_MIN_EVIDENCE ? state.calActual / state.calForecast : 1
}

export function step(prev: LocoRuntime, r: Reading, ctx: EstimatorContext): StepResult {
  if (r.seq <= prev.lastSeq) return { applied: false, state: prev, smoothed: null, effects: [] }

  const s: LocoRuntime = { ...prev, window: [...prev.window] }
  const effects: Effect[] = []
  const moving = r.speedMph >= 1
  // Grade compensation: only a moving train sits on a grade the profile can describe.
  const raw = r.fuelGal - (moving ? (ctx.tiltGal ?? 0) : 0)
  const dtHours = prev.lastSeq < 0 ? 0 : Math.max(0, (r.recordedAt - prev.lastAt) / 3_600_000)
  const levelBefore = s.level
  const wasLow = prev.level < ctx.reserveGal

  // 1. Predict from the previous interval's throttle notch.
  s.level -= rateForNotch(prev.lastNotch, prev.lastEngine) * dtHours
  s.variance += Q_PER_HOUR * dtHours

  // 2. Median of recent raw readings. After a gap the old readings describe a different level.
  if (dtHours > 0.25) s.window = []
  s.window.push(raw)
  if (s.window.length > 5) s.window.shift()
  const z = median(s.window)

  let fuelingSnap = false
  if (!moving) {
    // Fueling: the level jumps up while stationary. Follow it directly and reset the median window.
    const jump = s.sensorSuspect ? raw - prev.lastRaw : raw - s.level
    if (jump > FUELING_JUMP_GAL) {
      if (!s.fueling) s.fueling = { startedAt: r.recordedAt, levelBefore: levelBefore, milepost: r.milepost, lastRiseAt: r.recordedAt }
      s.fueling = { ...s.fueling, lastRiseAt: r.recordedAt }
      s.level = s.sensorSuspect ? s.level + jump : raw
      s.variance = 30 * 30
      s.window = [raw]
      s.stationary = null
      fuelingSnap = true
    }
  }
  if (s.fueling && !fuelingSnap && (moving || r.recordedAt - s.fueling.lastRiseAt >= FUELING_QUIET_MS)) {
    // Departed, or no rise for a while: the fueling event is complete.
    effects.push({ kind: 'fueling_completed', startedAt: s.fueling.startedAt, endedAt: r.recordedAt, levelBefore: s.fueling.levelBefore, levelAfter: s.level, milepost: s.fueling.milepost })
    s.fueling = null
  }

  if (!fuelingSnap) {
    // 3. Sensor fault: a sustained rise while moving can't be fuel. While a rise is being
    //    judged, hold the estimate rather than absorb what may be a bias.
    const suspiciousRise = moving && !s.sensorSuspect && z - s.level > SENSOR_FAULT_JUMP_GAL
    if (suspiciousRise) {
      s.riseStreak += 1
      if (s.riseStreak >= 3) {
        s.sensorSuspect = true
        effects.push({ kind: 'sensor_fault', jumpGal: z - s.level })
      }
    } else {
      s.riseStreak = 0
    }

    // 4. Correct with the sensor, trusting it less under acceleration (slosh).
    const accel = dtHours > 0 ? Math.abs(r.speedMph - prev.lastSpeed) / (dtHours * 60) : 0
    const sigma =
      s.sensorSuspect || suspiciousRise ? SIGMA_FAULTY : accel > ACCEL_SLOSH_MPH_PER_MIN ? SIGMA_SLOSH : moving ? SIGMA_MOVING : SIGMA_STATIONARY
    const R = sigma * sigma
    const K = s.variance / (s.variance + R)
    s.level += K * (z - s.level)
    s.variance = (1 - K) * s.variance
  }
  s.level = Math.min(ctx.capacityGal, Math.max(0, s.level))

  // 5. Loss while stationary (leak or theft): level falls faster than idling explains.
  if (!moving && !s.fueling) {
    if (!s.stationary) s.stationary = { since: r.recordedAt, level: s.level }
    else {
      const hours = (r.recordedAt - s.stationary.since) / 3_600_000
      const idle = r.engineState === 'off' ? 0 : IDLE_GAL_PER_HOUR * hours
      const loss = s.stationary.level - s.level - idle
      if (hours >= 0.5 && loss > STATIONARY_LOSS_GAL) {
        effects.push({ kind: 'stationary_loss', lossGal: loss, hours })
        s.stationary = { since: r.recordedAt, level: s.level }
      }
    }
  } else if (moving) {
    s.stationary = null
  }

  // 6. Calibration: filtered burn vs forecast over recent miles. Skipped across fueling and gaps.
  const miles = r.milepost - prev.lastMilepost
  if (moving && !fuelingSnap && !s.fueling && !s.sensorSuspect && prev.lastSeq >= 0 && dtHours < 1 && miles > 0) {
    const decay = Math.exp(-miles / CAL_DECAY_MILES)
    s.calActual = s.calActual * decay + (levelBefore - s.level)
    s.calForecast = s.calForecast * decay + ctx.forecastGallons
  }

  // 7. Low fuel, from telemetry alone: fires even when the planner is down.
  if (s.level < ctx.reserveGal && !wasLow) effects.push({ kind: 'low_fuel', level: s.level })
  if (s.level >= ctx.reserveGal * 1.2 && wasLow) effects.push({ kind: 'fuel_recovered' })

  s.lastSeq = r.seq
  s.lastAt = r.recordedAt
  s.lastRaw = raw
  s.lastSpeed = r.speedMph
  s.lastMilepost = r.milepost
  s.lastNotch = r.notch
  s.lastEngine = r.engineState
  return { applied: true, state: s, smoothed: s.level, effects }
}

/**
 * Applies a ticket correction to a dead-reckoning unit. A healthy sensor
 * re-converges on its own, so corrections only touch flagged units.
 */
export function applyCorrection(prev: LocoRuntime, c: Correction, capacityGal: number): LocoRuntime {
  const seen = prev.corrections ?? []
  if (!prev.sensorSuspect || seen.includes(c.ticketId)) return prev
  return {
    ...prev,
    level: Math.min(capacityGal, Math.max(0, prev.level + c.delta)),
    variance: 30 * 30,
    corrections: [...seen, c.ticketId].slice(-10),
  }
}

/** A unit whose calibration runs well above its consist-mates is likely leaking. */
export function leakSuspects(units: { id: string; cal: number; evidence: number }[]): string[] {
  const usable = units.filter((u) => u.evidence > CAL_MIN_EVIDENCE)
  if (usable.length < 2) return []
  return usable
    .filter((u) => {
      const others = usable.filter((o) => o.id !== u.id).map((o) => o.cal)
      const peer = median(others)
      return u.cal > 1.25 && u.cal > peer * 1.3
    })
    .map((u) => u.id)
}
