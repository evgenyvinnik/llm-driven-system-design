import { describe, expect, it } from 'vitest'
import { fits, queueWaitMinutes } from './capacity.js'
import { assessConfidence } from './confidence.js'
import { decide } from './hysteresis.js'
import { optimize } from './optimizer.js'
import type { PlanInputs, SimResult } from './types.js'

function sim(total: number, stops: string[], feasible = true): SimResult {
  return {
    feasible,
    breach: feasible ? null : { locationId: 'BAR', name: 'Barstow', milepost: 1545, headroomGal: -200 },
    unavailable: [],
    stops: stops.map((optionId, i) => ({
      seq: i + 1, locationId: optionId.slice(0, 3), name: optionId, optionId, kind: 'pad', milepost: 0, etaMs: 0, gallons: 1000, perUnit: [],
      pricePerGal: 2.5, fuelCost: 2500, fee: 0, delayCost: 0, dwellMinutes: 30, queueMinutes: 0, committed: false,
    })),
    cost: { fuel: total, fees: 0, delay: 0, stops: 0, cancellations: 0, terminalCredit: 0, total },
    profile: [],
    minHeadroom: 0,
    reserveTotalGal: 2000,
    capacityTotalGal: 20000,
  }
}

const P = { hysteresisAbs: 150, hysteresisPct: 0.02, acceptedChangeCost: 400 }

describe('hysteresis and acceptance', () => {
  it('keeps a recommended plan when the alternative saves less than the threshold', () => {
    const out = decide(sim(10_000, ['AMA-PAD']), sim(9_900, ['CLO-PAD']), P)
    expect(out).toMatchObject({ decision: 'keep_within_band', switched: false })
  })

  it('switches a recommended plan when the saving clears the threshold', () => {
    const out = decide(sim(10_000, ['AMA-PAD']), sim(9_500, ['CLO-PAD']), P)
    expect(out).toMatchObject({ decision: 'switch_savings', switched: true })
  })

  it('needs the change cost on top of the threshold once a plan is accepted, and only proposes', () => {
    // $500 saving clears $200 but not $200 + $400.
    expect(decide(sim(10_000, ['AMA-PAD']), sim(9_500, ['CLO-PAD']), P, { accepted: true }).decision).toBe('keep_within_band')
    const big = decide(sim(10_000, ['AMA-PAD']), sim(9_000, ['CLO-PAD']), P, { accepted: true })
    expect(big).toMatchObject({ decision: 'propose_change', switched: false })
    expect(big.explanation).toContain('Awaiting fuel desk confirmation')
  })

  it('replaces even an accepted plan at once when it has become unsafe, and says it is void', () => {
    const out = decide(sim(10_000, ['AMA-PAD'], false), sim(11_000, ['AMA-PAD', 'BEL-PAD']), P, { accepted: true })
    expect(out).toMatchObject({ decision: 'switch_unsafe', switched: true })
    expect(out.explanation).toContain('void')
  })
})

describe('shared pad capacity', () => {
  const H = 3_600_000
  it('adds no wait when a bay is free', () => {
    expect(queueWaitMinutes([{ start: 0, end: H }], 0, 60, 2)).toBe(0)
  })

  it('waits for the first bay to free up when all are taken', () => {
    const reserved = [{ start: 0, end: H }, { start: 0.5 * H, end: 2 * H }]
    expect(queueWaitMinutes(reserved, 0.25 * H, 30, 2)).toBe(45)
    expect(queueWaitMinutes([{ start: 0, end: H }], 0.5 * H, 30, 1)).toBe(30)
  })

  it('checks whether a new reservation fits', () => {
    const reserved = [{ start: 0, end: H }]
    expect(fits(reserved, 0.5 * H, 1.5 * H, 1)).toBe(false)
    expect(fits(reserved, H, 2 * H, 1)).toBe(true)
    expect(fits(reserved, 0.5 * H, 1.5 * H, 2)).toBe(true)
  })
})

describe('uncertain inputs', () => {
  const base = { baseMarginPct: 0.1, dataAgeHours: 0, trainCalibration: 1, sensorSuspectUnits: [], leakSuspectUnits: [], stalenessMarginPerHour: 0.03, maxExtraMargin: 0.2 }
  it('is high confidence with fresh data and a calibrated model', () => {
    expect(assessConfidence(base)).toMatchObject({ marginPct: 0.1, confidence: 'high' })
  })

  it('widens the margin for stale data and burn drift, and says why', () => {
    const c = assessConfidence({ ...base, dataAgeHours: 3, trainCalibration: 1.25 })
    expect(c.marginPct).toBeCloseTo(0.1 + 0.09 + 0.1, 6)
    expect(c.confidence).toBe('low')
    expect(c.assumptions.some((a) => a.includes('3.0 h old'))).toBe(true)
    expect(c.assumptions.some((a) => a.includes('+25%'))).toBe(true)
  })

  it('caps the extra margin', () => {
    const c = assessConfidence({ ...base, dataAgeHours: 20, sensorSuspectUnits: ['6260'], leakSuspectUnits: ['7302'] })
    expect(c.marginPct).toBeCloseTo(0.3, 6)
  })
})

describe('optimizer time budget', () => {
  it('reports a timeout instead of a plan when the deadline has passed', () => {
    const inputs: PlanInputs = {
      nowMs: 0,
      currentMilepost: 0,
      burnToFirst: 0,
      units: [{ locomotiveId: 'U1', capacityGal: 5000, fuelGal: 3000, reserveGal: 500, share: 1 }],
      points: [
        { locationId: 'A', name: 'A', milepost: 0, etaMs: 0, burnToNext: 1000, options: [] },
        { locationId: 'B', name: 'B', milepost: 100, etaMs: 0, burnToNext: 0, options: [] },
      ],
      params: { gridGal: 25, safetyMarginPct: 0.1, delayCostPerHour: 600, stopPenalty: 250, valueRemainingFuel: false },
      destinationPricePerGal: null,
    }
    expect(optimize(inputs, { deadline: performance.now() - 1 })).toMatchObject({ timedOut: true, feasible: false })
    expect(optimize(inputs).feasible).toBe(true)
  })
})
