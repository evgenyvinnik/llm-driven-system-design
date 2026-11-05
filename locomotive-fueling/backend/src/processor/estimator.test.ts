import { describe, expect, it } from 'vitest'
import { applyCorrection, calibration, initialRuntime, leakSuspects, median, step, type LocoRuntime, type Reading } from './estimator.js'

const CTX = { capacityGal: 5000, reserveGal: 500, forecastGallons: 0 }
const MIN = 60_000

function reading(seq: number, fuelGal: number, extra: Partial<Reading> = {}): Reading {
  return { locomotiveId: 'U1', seq, recordedAt: seq * 3 * MIN, lat: 0, lon: 0, milepost: seq * 2, speedMph: 40, notch: 4, fuelGal, engineState: 'run', ...extra }
}

/** Deterministic noise in [-1, 1]. */
function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

function run(readings: Reading[], start: LocoRuntime = initialRuntime(4000, 0, 0, 0), ctx = CTX) {
  let state = start
  const out: { smoothed: number | null; effects: string[] }[] = []
  for (const r of readings) {
    const res = step(state, r, ctx)
    state = res.state
    out.push({ smoothed: res.smoothed, effects: res.effects.map((e) => e.kind) })
  }
  return { state, out }
}

describe('smoothing', () => {
  it('tracks the true level through heavy slosh noise better than the raw sensor', () => {
    // Truth: 4000 gal falling 3.75 gal per 3-minute reading (notch 4 = 75 gal/hr). Sensor: ±150 gal slosh + spikes.
    const truth = (i: number) => 4000 - 3.75 * i
    const readings = Array.from({ length: 120 }, (_, k) => {
      const i = k + 1
      const spike = i % 17 === 0 ? 600 : 0
      return reading(i, truth(i) + 150 * noise(i) + spike)
    })
    const { out } = run(readings)
    let rawErr = 0
    let estErr = 0
    readings.forEach((r, k) => {
      if (k < 20) return
      rawErr += Math.abs(r.fuelGal - truth(k + 1))
      estErr += Math.abs((out[k].smoothed ?? 0) - truth(k + 1))
    })
    expect(estErr).toBeLessThan(rawErr / 3)
    expect(Math.abs((out[119].smoothed ?? 0) - truth(120))).toBeLessThan(60)
  })

  it('median rejects a single spike', () => {
    expect(median([100, 102, 900, 101, 99])).toBe(101)
  })
})

describe('ordering and duplicates', () => {
  it('ignores a reading whose sequence is not newer (duplicate or late)', () => {
    const { state } = run([reading(1, 3990), reading(2, 3985), reading(3, 3980)])
    const dup = step(state, reading(2, 3985), CTX)
    expect(dup.applied).toBe(false)
    expect(dup.state).toBe(state)
    const late = step(state, reading(1, 2000), CTX)
    expect(late.applied).toBe(false)
    expect(late.smoothed).toBeNull()
  })

  it('is idempotent under redelivery: replaying a batch from saved state gives the same result', () => {
    const batch = [reading(1, 3990), reading(2, 3985), reading(3, 3981)]
    const once = run(batch)
    const replayed = run(batch, once.state)
    expect(replayed.out.every((o) => o.smoothed === null)).toBe(true)
    expect(replayed.state).toEqual(once.state)
  })

  it('bridges a gap (dark territory) by predicting from the notch, then trusts the sensor more', () => {
    const before = run([reading(1, 4000), reading(2, 3996)])
    // 20 readings missing: next reading is an hour later.
    const after = step(before.state, reading(22, 3925), CTX)
    expect(after.applied).toBe(true)
    expect(after.smoothed!).toBeGreaterThan(3900)
    expect(after.smoothed!).toBeLessThan(3950)
  })
})

describe('events', () => {
  it('detects fueling while stationary and reports it on departure', () => {
    const stopped = { speedMph: 0, notch: 0, engineState: 'idle' as const }
    const seq = [
      reading(1, 1500, stopped),
      reading(2, 1500, stopped),
      reading(3, 2400, stopped),
      reading(4, 3300, stopped),
      reading(5, 4200, stopped),
      reading(6, 4200, { speedMph: 10 }),
    ]
    const { out, state } = run(seq, initialRuntime(1500, 0, 0, 0))
    expect(out[5].effects).toContain('fueling_completed')
    expect(state.level).toBeGreaterThan(4100)
  })

  it('flags a sensor fault when the level rises while moving, then dead-reckons', () => {
    const readings = Array.from({ length: 10 }, (_, k) => reading(k + 1, 4000 - 3.75 * (k + 1) + (k >= 3 ? 500 : 0)))
    const { out, state } = run(readings)
    expect(out.flatMap((o) => o.effects)).toContain('sensor_fault')
    expect(state.sensorSuspect).toBe(true)
    // The bias is not absorbed into the estimate.
    expect(state.level).toBeLessThan(4050)
  })

  it('flags fuel loss while stationary beyond idle burn', () => {
    const idle = { speedMph: 0, notch: 0, engineState: 'idle' as const }
    const readings = Array.from({ length: 16 }, (_, k) => reading(k + 1, 3000 - 8 * (k + 1), idle))
    const { out } = run(readings, initialRuntime(3000, 0, 0, 0))
    expect(out.flatMap((o) => o.effects)).toContain('stationary_loss')
  })

  it('raises low fuel once when crossing below reserve and recovers after fueling', () => {
    const readings = Array.from({ length: 30 }, (_, k) => reading(k + 1, 560 - 3.75 * (k + 1)))
    const { out } = run(readings, initialRuntime(560, 0, 0, 0))
    expect(out.flatMap((o) => o.effects).filter((e) => e === 'low_fuel')).toHaveLength(1)
  })
})

describe('calibration', () => {
  it('converges to the actual/forecast ratio of a heavier-than-planned train', () => {
    // Forecast says 3 gal per reading; the train actually burns 3.75 (25% heavier).
    const readings = Array.from({ length: 150 }, (_, k) => reading(k + 1, 4900 - 3.75 * (k + 1) + 40 * noise(k)))
    const { state } = run(readings, initialRuntime(4900, 0, 0, 0), { ...CTX, forecastGallons: 3 })
    expect(calibration(state)).toBeGreaterThan(1.15)
    expect(calibration(state)).toBeLessThan(1.35)
  })

  it('picks out a unit burning far above its consist-mates', () => {
    expect(
      leakSuspects([
        { id: 'A', cal: 1.02, evidence: 400 },
        { id: 'B', cal: 0.98, evidence: 400 },
        { id: 'C', cal: 1.9, evidence: 400 },
      ]),
    ).toEqual(['C'])
    // A uniformly heavy train is not a leak.
    expect(leakSuspects([{ id: 'A', cal: 1.3, evidence: 400 }, { id: 'B', cal: 1.28, evidence: 400 }])).toEqual([])
  })
})

describe('ticket corrections', () => {
  it('applies a correction once, and only to a dead-reckoning unit', () => {
    const healthy = initialRuntime(3000, 5, 0, 0)
    expect(applyCorrection(healthy, { locomotiveId: 'U1', delta: 200, ticketId: 'T1' }, 5000)).toBe(healthy)
    const faulty = { ...healthy, sensorSuspect: true }
    const once = applyCorrection(faulty, { locomotiveId: 'U1', delta: 200, ticketId: 'T1' }, 5000)
    expect(once.level).toBe(3200)
    expect(applyCorrection(once, { locomotiveId: 'U1', delta: 200, ticketId: 'T1' }, 5000).level).toBe(3200)
  })
})
