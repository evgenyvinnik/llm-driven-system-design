import { describe, expect, it } from 'vitest'
import { TIER } from '../shared/domain.js'
import { YARDS } from '../shared/network.js'
import { estimateMilepost, isLate, predictNextYard, routeAlert, type TripState } from './routing.js'

const H = 3_600_000
const eastbound: TripState = {
  status: 'en_route', direction: 'EB', stops: ['CDJ', 'RDG'], arrivedYardId: null, speedMph: 45,
  lastMilepost: 100, lastPassAtMs: 0, destinationMp: 240, originMp: 0,
}

describe('position and next yard', () => {
  it('dead-reckons from the newest pass and clamps at the destination', () => {
    expect(estimateMilepost(eastbound, 0.4 * H)).toBeCloseTo(118)
    expect(estimateMilepost(eastbound, 10 * H)).toBe(240)
  })

  it('predicts the first stop still ahead in the direction of travel', () => {
    expect(predictNextYard(eastbound, 100, YARDS)?.yard.id).toBe('CDJ')
    expect(predictNextYard(eastbound, 126, YARDS)?.yard.id).toBe('RDG')
    expect(predictNextYard({ ...eastbound, direction: 'WB', stops: ['CDJ', 'HAR'] }, 126, YARDS)?.yard.id).toBe('CDJ')
  })
})

describe('late data', () => {
  it('marks data late past the configured age', () => {
    expect(isLate(14 * 60, 15)).toBe(false)
    expect(isLate(16 * 60, 15)).toBe(true)
  })

  it('sends a late MEDIUM for a train that already arrived to that yard, not to a dispatcher', () => {
    const arrived: TripState = { ...eastbound, status: 'arrived', arrivedYardId: 'CDJ', destinationMp: 118 }
    const route = routeAlert({ tier: TIER.MEDIUM, lagSeconds: 70 * 60, lateAfterMinutes: 15, trip: arrived, nowMs: 3 * H, yards: YARDS, readingMilepost: 112 })
    expect(route).toMatchObject({ routing: 'yard_post_arrival', yardId: 'CDJ', deskId: null, late: true, lagMinutes: 70 })
    expect(route.note).toMatch(/already arrived at CDJ/)
  })

  it('still sends a late HIGH to the dispatcher of the territory the train is in now, saying how far it has moved', () => {
    const route = routeAlert({ tier: TIER.HIGH, lagSeconds: 90 * 60, lateAfterMinutes: 15, trip: { ...eastbound, lastMilepost: 140, lastPassAtMs: 0 }, nowMs: 0.5 * H, yards: YARDS, readingMilepost: 112 })
    expect(route.routing).toBe('dispatcher_and_yard')
    expect(route.territoryId).toBe('RIDGEWAY')
    expect(route.deskId).toBe('EAST')
    expect(route.yardId).toBe('RDG')
    expect(route.note).toMatch(/now about \d+ mi past the reading/)
  })

  it('routes fresh MEDIUM to the next yard and LOW to the owner only', () => {
    expect(routeAlert({ tier: TIER.MEDIUM, lagSeconds: 30, lateAfterMinutes: 15, trip: eastbound, nowMs: 0, yards: YARDS, readingMilepost: 100 })).toMatchObject({ routing: 'yard', yardId: 'CDJ', late: false })
    expect(routeAlert({ tier: TIER.LOW, lagSeconds: 30, lateAfterMinutes: 15, trip: eastbound, nowMs: 0, yards: YARDS, readingMilepost: 100 }).routing).toBe('owner_only')
  })
})
