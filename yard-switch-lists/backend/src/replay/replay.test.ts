import { describe, expect, it } from 'vitest'
import { computeReplayMetrics, disruptionsFor, runPolicy, summarize } from './engine.js'
import { initialSnapshot } from '../domain/scenario.js'

describe('replay', () => {
  it('the same seed gives the same result, down to the digest', async () => {
    const a = await runPolicy(42, 'planner', { iterations: 60 })
    const b = await runPolicy(42, 'planner', { iterations: 60 })
    expect(a.digest).toBe(b.digest)
  }, 30_000)

  it('every policy faces the same disruptions', () => {
    const snap = initialSnapshot(7)
    expect(disruptionsFor(7, snap)).toEqual(disruptionsFor(7, initialSnapshot(7)))
  })

  it('never ships an invalid plan, and baseline and planner both finish the shift', async () => {
    for (const policy of ['planner', 'baseline', 'planner_overrides'] as const) {
      const r = await runPolicy(11, policy, { iterations: 60 })
      expect(r.metrics.invalidPlans).toBe(0)
      expect(r.departures).toHaveLength(7)
      expect(r.metrics.carsDeparted).toBeGreaterThan(0)
    }
  }, 60_000)

  it('only the scripted yardmaster overrides', async () => {
    const planner = await runPolicy(11, 'planner', { iterations: 40 })
    const human = await runPolicy(11, 'planner_overrides', { iterations: 40 })
    expect(planner.metrics.overrides).toBe(0)
    expect(human.metrics.overrides).toBeGreaterThan(0)
    expect(Object.keys(human.metrics.overrideReasons).length).toBeGreaterThan(0)
  }, 30_000)
})

describe('metrics', () => {
  const departures = [
    { outboundId: 'a', symbol: 'A', scheduled: 0, actual: 0, cars: 2, status: 'departed', onTime: true },
    { outboundId: 'b', symbol: 'B', scheduled: 0, actual: 60, cars: 1, status: 'departed', onTime: false },
    { outboundId: 'c', symbol: 'C', scheduled: 0, actual: null, cars: 0, status: 'missed', onTime: false },
  ]
  const cars = [
    { carId: '1', arrivedAt: 0, departedAt: 3_600_000, handlings: 2 },
    { carId: '2', arrivedAt: 0, departedAt: 7_200_000, handlings: 3 },
    { carId: '3', arrivedAt: 0, departedAt: null, handlings: 1 },
    { carId: '4', arrivedAt: null, departedAt: null, handlings: 0 },
  ]
  const events = [
    { kind: 'override' as const, at: 0, code: 'protect_departure', value: 1, detail: '' },
    { kind: 'override' as const, at: 0, code: 'protect_departure', value: 1, detail: '' },
    { kind: 'capacity' as const, at: 0, code: 'C1', value: 30, detail: '' },
    { kind: 'replan' as const, at: 0, code: 'ok', value: 5, detail: '' },
  ]

  it('computes on-time, moves per car, dwell, capacity and override rate', () => {
    const m = computeReplayMetrics(departures, cars, events, 0, 1, 5, 40)
    expect(m).toMatchObject({ trains: 3, onTime: 1, onTimePct: 33.3, missed: 1, carsDeparted: 2, carsStranded: 1, movesPerCar: 2, avgDwellHours: 1.5, capacityViolations: 1, overrides: 2, overrideRatePer100Moves: 5, disturbedMoves: 5 })
    expect(m.overrideReasons).toEqual({ protect_departure: 2 })
  })

  it('handles an empty run without dividing by zero', () => {
    const m = computeReplayMetrics([], [], [], 0, 0, 0, 0)
    expect(m).toMatchObject({ onTimePct: 0, movesPerCar: 0, avgDwellHours: 0, overrideRatePer100Moves: 0 })
  })

  it('summarizes across seeds from raw rows, not by averaging averages', async () => {
    const outcomes = await Promise.all([runPolicy(42, 'baseline', { iterations: 1 }), runPolicy(7, 'baseline', { iterations: 1 })])
    const row = summarize(outcomes).find((r) => r.policy === 'baseline')!
    const onTime = outcomes.flatMap((o) => o.departures).filter((d) => d.onTime).length
    expect(row.shifts).toBe(2)
    expect(row.onTimePct).toBe(Math.round((onTime / 14) * 1000) / 10)
  })
})
