import { describe, expect, it } from 'vitest'
import { foldCar } from './car-fold.js'
import { computeEta } from './eta-model.js'
import { CAR, ev, tripToMidland } from './fixtures.js'

const opts = { lateAfterMinutes: 60 }
const hours = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 3_600_000

describe('computeEta (dwell-based)', () => {
  const atMidland = foldCar(CAR, tripToMidland(), opts)

  it('is deterministic: the same events give the same ETA (replay-safe)', () => {
    expect(computeEta(atMidland)).toEqual(computeEta(foldCar(CAR, [...tripToMidland()].reverse(), opts)))
  })

  it('returns an ordered p10 ≤ p50 ≤ p90 range', () => {
    const eta = computeEta(atMidland)!
    expect(Date.parse(eta.p10)).toBeLessThanOrEqual(Date.parse(eta.p50))
    expect(Date.parse(eta.p50)).toBeLessThanOrEqual(Date.parse(eta.p90))
    expect(eta.final).toBe(false)
  })

  it('spends most of the remaining time in yards, not on trains', () => {
    const eta = computeEta(atMidland)!
    expect(eta.basis.yardHours).toBeGreaterThan(eta.basis.transitHours)
    expect(eta.basis.yardShare).toBeGreaterThan(0.5)
  })

  it('moves the ETA later when the inbound train is delayed past the connection', () => {
    const departed = tripToMidland().slice(0, 5) // on the train, before arrival
    const onTime = computeEta(foldCar(CAR, departed, opts))!
    const delay = ev('TrainDelayed', '2026-11-04T08:00:00.000Z', { runId: 'M-NGTMID-20261104', trainId: 'M-NGTMID', delayMinutes: 360, newEtaAt: '2026-11-04T18:00:00.000Z', location: 'MP 112', reason: 'crew' })
    const late = computeEta(foldCar(CAR, [...departed, delay], opts))!
    expect(hours(late.p50, onTime.p50)).toBeGreaterThan(6)
    // With a 6 h delay into a 5 h minimum connection, the 20:00 train is almost always missed.
    expect(late.basis.missNextConnection).toBeGreaterThan(0.9)
  })

  it('skips a cancelled planned train and waits for the next one', () => {
    const cancel = ev('TrainCancelled', '2026-11-04T13:00:00.000Z', { runId: 'M-MIDPRT-20261104', trainId: 'M-MIDPRT', fromYard: 'MID', reason: 'no power' })
    const withCancel = computeEta(foldCar(CAR, [...tripToMidland(), cancel], opts))!
    expect(Date.parse(withCancel.p50)).toBeGreaterThan(Date.parse(computeEta(atMidland)!.p50))
    expect(withCancel.basis.missNextConnection).toBe(1)
  })

  it('moves with the clock: time that passed with no news is conditioned on (ClockTicked floor)', () => {
    const base = computeEta(atMidland)!
    const later = computeEta(atMidland, 200, '2026-11-05T02:00:00.000Z')!
    expect(later.asOf).toBe('2026-11-05T02:00:00.000Z')
    expect(Date.parse(later.p10)).toBeGreaterThanOrEqual(Date.parse('2026-11-05T02:00:00.000Z'))
    expect(Date.parse(later.p50)).toBeGreaterThanOrEqual(Date.parse(base.p50))
    // A floor older than the newest event changes nothing.
    expect(computeEta(atMidland, 200, '2026-11-01T00:00:00.000Z')).toEqual(base)
  })

  it('does not push a car off a planned train it is simply waiting for as the clock advances', () => {
    // At Midland since 12:30, planned on the 20:00 train; at 19:00 nothing has gone wrong yet.
    const atArrival = computeEta(atMidland)!
    const waiting = computeEta(atMidland, 200, '2026-11-04T19:00:00.000Z')!
    expect(waiting.basis.missNextConnection).toBeLessThanOrEqual(atArrival.basis.missNextConnection)
    expect(waiting.basis.missNextConnection).toBeLessThan(0.5)
  })

  it('is final and exact once the car is placed', () => {
    const placed = ev('CarPlaced', '2026-11-05T14:00:00.000Z', { carId: CAR, customerId: 'PRT-EXPORT-1', yardId: 'PRT', railroad: 'PN' })
    const eta = computeEta(foldCar(CAR, [...tripToMidland(), placed], opts))!
    expect(eta.final).toBe(true)
    expect(eta.p10).toBe(eta.p90)
    expect(eta.p50).toBe('2026-11-05T14:00:00.000Z')
  })

  it('widens confidence when the position is only inferred', () => {
    const inferred = foldCar(CAR, tripToMidland().filter((e) => e.type !== 'CarArrivedYard' && e.type !== 'CarSighted'), opts)
    const order = ['high', 'medium', 'low']
    expect(order.indexOf(computeEta(inferred)!.confidence)).toBeGreaterThanOrEqual(order.indexOf(computeEta(atMidland)!.confidence))
  })
})
