import { describe, expect, it } from 'vitest'
import { foldCar } from './car-fold.js'
import { CAR, ev, planCreated, shuffle, tripToMidland } from './fixtures.js'

const opts = { lateAfterMinutes: 60 }

describe('foldCar', () => {
  it('tracks an observed trip against its plan', () => {
    const s = foldCar(CAR, tripToMidland(), opts)
    expect(s.status).toBe('at_yard')
    expect(s.locationId).toBe('MID')
    expect(s.positionConfidence).toBe('observed')
    expect(s.positionSource).toBe('CarArrivedYard')
    expect(s.currentLeg).toBe(1)
    expect(s.planStatus).toBe('on_plan')
    expect(s.missedReads).toBe(0)
  })

  it('gives the same state whatever order the events arrived in', () => {
    const events = tripToMidland()
    const inOrder = foldCar(CAR, events, opts)
    for (const seed of [1, 7, 42, 99, 1234]) {
      const shuffled = shuffle(events, seed).map((e, i) => ({ ...e, position: i + 1 }))
      const s = foldCar(CAR, shuffled, opts)
      expect({ ...s, outOfOrderEvents: 0, lateEvents: 0 }).toEqual({ ...inOrder, outOfOrderEvents: 0, lateEvents: 0 })
    }
  })

  it('infers the car from train movement when AEI and yard reads are missing, and counts the missed reads', () => {
    const events = tripToMidland().filter((e) => e.type !== 'CarSighted' && e.type !== 'CarArrivedYard' && e.type !== 'CarDepartedYard')
    const s = foldCar(CAR, events, opts)
    expect(s.status).toBe('at_yard')
    expect(s.locationId).toBe('MID')
    expect(s.positionConfidence).toBe('inferred')
    expect(s.positionSource).toBe('TrainArrived')
    expect(s.missedReads).toBe(2) // no yard read at MID, no line read between NGT and MID
  })

  it('upgrades an inferred position when a late yard report arrives', () => {
    const events = tripToMidland().filter((e) => e.type !== 'CarArrivedYard')
    expect(foldCar(CAR, events, opts).positionConfidence).toBe('inferred')
    const late = ev('CarArrivedYard', '2026-11-04T12:30:00.000Z', { carId: CAR, yardId: 'MID', trainRunId: null, track: null }, { position: 50, recordedAt: '2026-11-04T19:00:00.000Z', producer: 'yard:MID' })
    const s = foldCar(CAR, [...events, late], opts)
    expect(s.positionConfidence).toBe('observed')
    expect(s.lateEvents).toBe(1)
  })

  it('places a car in transit from TrainDeparted alone (no car-level departure report)', () => {
    const events = tripToMidland().slice(0, 4).filter((e) => e.type !== 'CarDepartedYard')
    const s = foldCar(CAR, events, opts)
    expect(s.status).toBe('in_transit')
    expect(s.trainRunId).toBe('M-NGTMID-20261104')
    expect(s.positionConfidence).toBe('inferred')
  })

  it('counts out-of-order arrival without letting it change the outcome', () => {
    const events = tripToMidland()
    // The line read arrives after the yard arrival was already recorded.
    const reordered = [events[0], events[1], events[2], events[3], events[5], events[6], { ...events[4], position: 99 }]
    const s = foldCar(CAR, reordered, opts)
    expect(s.outOfOrderEvents).toBe(1)
    expect(s.locationId).toBe('MID')
  })

  it('marks the plan as missed when a ConnectionMissed names the current version', () => {
    const miss = ev('ConnectionMissed', '2026-11-04T20:00:00.000Z', {
      carId: CAR, tripId: `T-${CAR}`, shipperId: 'S01', planVersion: 1, legSeq: 1, runId: 'M-MIDPRT-20261104', trainId: 'M-MIDPRT', yardId: 'MID',
      plannedDeparture: '2026-11-04T20:00:00.000Z', reason: 'departed_without_car', predicted: false, availableAt: '2026-11-04T20:00:00.000Z', inboundRunId: null,
    }, { producer: 'svc:car-state' })
    expect(foldCar(CAR, [...tripToMidland(), miss], opts).planStatus).toBe('missed_connection')
  })

  it('treats the highest plan version as current, regardless of event time', () => {
    const revised = ev('TripPlanRevised', '2026-11-04T19:00:00.000Z', {
      tripId: `T-${CAR}`, carId: CAR, shipperId: 'S01', version: 2, previousVersion: 1, revisedBy: 'replanner', sagaId: 'RP-1',
      legs: [{ seq: 1, trainId: 'Z-MIDPRT', runId: 'Z-MIDPRT-20261105', fromYard: 'MID', toYard: 'PRT', plannedDeparture: '2026-11-05T07:00:00.000Z', plannedArrival: '2026-11-05T16:00:00.000Z' }],
      reason: { code: 'missed_connection', text: 'x', missedRunId: 'M-MIDPRT-20261104', yardId: 'MID' },
    })
    const s = foldCar(CAR, [planCreated(), revised], opts)
    expect(s.plan?.version).toBe(2)
    expect(s.plan?.legs[0].runId).toBe('Z-MIDPRT-20261105')
  })
})
