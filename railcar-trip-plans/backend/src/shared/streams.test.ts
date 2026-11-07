import { describe, expect, it } from 'vitest'
import { routeOf, naturalKey } from './events/catalog.js'
import { idTime, partitionFor, streamFor } from './streams.js'
import { canTransition, TRANSITIONS } from '../replanner/saga.js'

describe('partitioning', () => {
  it('maps a key to the same partition every time, within range', () => {
    for (const key of ['HPSX104300', 'M-NGTMID-20261104', 'S01']) {
      const p = partitionFor(key, 4)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(4)
      expect(partitionFor(key, 4)).toBe(p)
    }
  })

  it('spreads many car ids across partitions', () => {
    const counts = [0, 0, 0, 0]
    for (let i = 0; i < 400; i++) counts[partitionFor(`HPSX${104200 + i}`, 4)]++
    for (const c of counts) expect(c).toBeGreaterThan(60)
  })

  it('routes facts, plans and decisions about a car to the car partition, and train facts by run', () => {
    expect(routeOf('CarArrivedYard', { carId: 'HPSX1', yardId: 'MID', trainRunId: null, track: null })).toMatchObject({ topic: 'car', partitionKey: 'HPSX1', streamId: 'car-HPSX1' })
    expect(routeOf('TrainDelayed', { runId: 'R1', trainId: 'T', delayMinutes: 5, newEtaAt: '2026-11-04T00:00:00Z', location: 'x', reason: 'y' })).toMatchObject({ topic: 'train', partitionKey: 'R1' })
    expect(streamFor('car', 'HPSX1')).toMatch(/^tp:car:[0-3]$/)
  })

  it('gives a resend under a new event id the same natural key', () => {
    const p = { carId: 'HPSX1', interchangePoint: 'SDV', direction: 'received', fromRoad: 'LPS', toRoad: 'PN' }
    expect(naturalKey('CarInterchanged', p, '2026-11-04T03:12:41.000Z')).toBe(naturalKey('CarInterchanged', p, '2026-11-04T03:12:05.000Z'))
  })

  it('reads the time out of a stream entry id', () => {
    expect(idTime('1730851200000-3')).toBe(1730851200000)
    expect(idTime(null)).toBeNull()
  })
})

describe('replanning saga state machine', () => {
  it('allows only forward transitions and compensation', () => {
    expect(canTransition('started', 'reserved')).toBe(true)
    expect(canTransition('reserved', 'awaiting_eta')).toBe(true)
    expect(canTransition('awaiting_eta', 'completed')).toBe(true)
    expect(canTransition('completed', 'compensated')).toBe(true)
    expect(canTransition('completed', 'started')).toBe(false)
    expect(canTransition('failed', 'reserved')).toBe(false)
    expect(TRANSITIONS.compensated).toEqual([])
  })
})
