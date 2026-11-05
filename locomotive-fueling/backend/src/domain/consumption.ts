/**
 * Fuel consumption model. Physics-informed and deliberately simple: the work a
 * train does over a segment is rolling + curve resistance over the distance
 * plus lifting its weight over the climb, and diesel delivers a fixed amount of
 * work at the rail per gallon. Descents are treated as zero work (dynamic
 * braking), which overstates downhill burn slightly. All constants are
 * illustrative assumptions.
 *
 * Shared by the planner (forecast with planned tonnage), the processor
 * (calibration: actual burn vs this forecast) and the simulator (truth, with
 * actual tonnage and per-unit quirks).
 * @module domain/consumption
 */

/** ≈137,000 BTU/gal × 778 ft·lbf/BTU × ~33% fuel-to-rail efficiency. */
export const FT_LBF_PER_GAL_AT_RAIL = 35e6
/** Idle and auxiliary load per running unit (compressors, cooling, hotel power). */
export const IDLE_GAL_PER_HOUR = 4
/** Planned running speed as a share of the segment's track speed (meets, slow orders). */
export const PLANNED_SPEED_FACTOR = 0.9

/** Burn rate by throttle notch for a ~4,400 hp unit, gal/hr. Illustrative. Index 0 is idle. */
export const NOTCH_GAL_PER_HOUR = [4, 15, 30, 50, 75, 100, 130, 165, 200]

/** Davis-style rolling resistance, lb/ton (bearing, flange and air drag lumped together). */
export function rollingLbPerTon(speedMph: number): number {
  return 2.0 + 0.04 * speedMph + 0.0008 * speedMph * speedMph
}

/** Work-only gallons for the whole train over a distance and climb. */
export function workGallons(tons: number, miles: number, riseFt: number, curveLbPerTon: number, speedMph: number): number {
  const resistance = (rollingLbPerTon(speedMph) + curveLbPerTon) * miles * 5280
  const lift = 2000 * Math.max(0, riseFt)
  return (tons * (resistance + lift)) / FT_LBF_PER_GAL_AT_RAIL
}

export interface Leg {
  from: string
  to: string
  startMile: number
  endMile: number
  miles: number
  rise: number
  curveLbPerTon: number
  speedMph: number
  dark: boolean
}

export interface TrackLike {
  a: string
  b: string
  miles: number
  riseAb: number
  riseBa: number
  curveLbPerTon: number
  speedMph: number
  dark: boolean
}

/** Turns a path of location ids into legs with cumulative mileposts. */
export function buildLegs(path: string[], tracks: TrackLike[]): Leg[] {
  const legs: Leg[] = []
  let mile = 0
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i]
    const to = path[i + 1]
    const t = tracks.find((x) => (x.a === from && x.b === to) || (x.a === to && x.b === from))
    if (!t) throw new Error(`no track between ${from} and ${to}`)
    const rise = t.a === from ? t.riseAb : t.riseBa
    legs.push({ from, to, startMile: mile, endMile: mile + t.miles, miles: t.miles, rise, curveLbPerTon: t.curveLbPerTon, speedMph: t.speedMph, dark: t.dark })
    mile += t.miles
  }
  return legs
}

/** Milepost of every node on the path (first is 0). */
export function nodeMileposts(legs: Leg[]): { locationId: string; milepost: number }[] {
  if (legs.length === 0) return []
  return [{ locationId: legs[0].from, milepost: 0 }, ...legs.map((l) => ({ locationId: l.to, milepost: l.endMile }))]
}

export function legAt(legs: Leg[], milepost: number): Leg | undefined {
  return legs.find((l) => milepost >= l.startMile && milepost < l.endMile) ?? legs[legs.length - 1]
}

/**
 * Forecast train burn (nominal, before per-unit shares and calibration) between
 * two mileposts, assuming the planned speed. Partial legs are prorated,
 * including the climb.
 */
export function forecastBurn(legs: Leg[], fromMile: number, toMile: number, tons: number, unitCount: number): { gallons: number; hours: number } {
  let gallons = 0
  let hours = 0
  for (const leg of legs) {
    const lo = Math.max(fromMile, leg.startMile)
    const hi = Math.min(toMile, leg.endMile)
    if (hi <= lo) continue
    const frac = (hi - lo) / leg.miles
    const speed = leg.speedMph * PLANNED_SPEED_FACTOR
    const legHours = (hi - lo) / speed
    gallons += workGallons(tons, hi - lo, leg.rise * frac, leg.curveLbPerTon, speed) + IDLE_GAL_PER_HOUR * unitCount * legHours
    hours += legHours
  }
  return { gallons, hours }
}

export interface UnitShareInput {
  horsepower: number
  modelFactor: number
  /** Observed/forecast burn ratio for this unit (1 = matches the model). */
  calibration: number
  online: boolean
}

/**
 * Each unit's share of the train's burn: its share of horsepower, scaled by its
 * model's efficiency and its own calibration. Shares sum to about 1 for a
 * well-calibrated consist; a leaking unit's share grows.
 */
export function unitShares(units: UnitShareInput[]): number[] {
  const totalHp = units.reduce((s, u) => s + (u.online ? u.horsepower : 0), 0) || 1
  return units.map((u) => {
    const work = u.online ? u.horsepower / totalHp : 0
    const k = Math.min(2.5, Math.max(0.7, u.calibration))
    // An isolated unit still idles: give it a floor so the reserve math never divides by zero.
    return Math.max(0.02, work * u.modelFactor * k)
  })
}

/** Nearest notch for a unit burn rate (gal/hr). */
export function notchForRate(galPerHour: number): number {
  let best = 0
  for (let n = 0; n < NOTCH_GAL_PER_HOUR.length; n++) {
    if (Math.abs(NOTCH_GAL_PER_HOUR[n] - galPerHour) < Math.abs(NOTCH_GAL_PER_HOUR[best] - galPerHour)) best = n
  }
  return best
}

export function rateForNotch(notch: number, engineState: string): number {
  if (engineState === 'off') return 0
  return NOTCH_GAL_PER_HOUR[Math.max(0, Math.min(8, Math.round(notch)))]
}

/**
 * A level sensor at one end of a tilted tank reads high on a climb. With the
 * track profile known, the predictable part can be removed before filtering.
 * Illustrative tank geometry: about 260 gal of apparent level per 1% grade.
 */
export const TILT_GAL_PER_PCT_GRADE = 260

export function tiltOffset(leg: Leg | undefined): number {
  if (!leg) return 0
  return TILT_GAL_PER_PCT_GRADE * ((leg.rise / (leg.miles * 5280)) * 100)
}

/** Per-unit reserve: a percentage of the tank, never below an absolute floor. */
export function reserveGallons(capacityGal: number, reservePct: number, reserveMinGal: number): number {
  return Math.max(capacityGal * reservePct, reserveMinGal)
}
