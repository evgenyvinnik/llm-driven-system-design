/**
 * Replay equivalence: the live projection, built message by message as events arrive (late, out of order,
 * duplicated, with redeliveries), must equal the projection rebuilt from the log from position 0.
 */
import { describe, expect, it } from 'vitest'
import { foldCar, type CarState } from '../domain/car-fold.js'
import { computeEta } from '../domain/eta-model.js'
import { CAR, ev, shuffle, tripToMidland } from '../domain/fixtures.js'
import type { AnyEnvelope } from '../shared/events/envelope.js'

const opts = { lateAfterMinutes: 60 }

/** The live path: an append-only log with dedupe, and a projection refolded after each delivered message. */
function live(deliveries: AnyEnvelope[]) {
  const log: AnyEnvelope[] = []
  const seen = new Set<string>()
  let state: CarState | null = null
  let processed = 0
  for (const e of deliveries) {
    if (!seen.has(e.eventId)) {
      seen.add(e.eventId)
      log.push({ ...e, position: log.length + 1 })
    }
    // A redelivery still refolds (harmlessly); the idempotency marker would normally skip it.
    state = foldCar(CAR, log, opts)
    processed++
  }
  return { log, state: state!, processed }
}

describe('replay equivalence', () => {
  const trip = tripToMidland()
  const delay = ev('TrainDelayed', '2026-11-04T08:00:00.000Z', { runId: 'M-NGTMID-20261104', trainId: 'M-NGTMID', delayMinutes: 180, newEtaAt: '2026-11-04T15:00:00.000Z', location: 'MP 112', reason: 'meet' })
  const all = [...trip, delay]

  it('rebuilding car-state from position 0 equals the live projection, for many arrival orders', () => {
    for (const seed of [3, 11, 29, 31337]) {
      const arrivals = shuffle(all, seed)
      const withDuplicates = [...arrivals, arrivals[2], arrivals[5], arrivals[0]]
      const { log, state } = live(withDuplicates)
      expect(log).toHaveLength(all.length)
      const rebuilt = foldCar(CAR, [...log].sort((a, b) => a.position - b.position), opts)
      expect(rebuilt).toEqual(state)
    }
  })

  it('rebuilding the ETA from position 0 equals the ETA the live consumer stored', () => {
    for (const seed of [5, 8]) {
      const { log, state } = live(shuffle(all, seed))
      expect(computeEta(foldCar(CAR, log, opts))).toEqual(computeEta(state))
    }
  })

  it('the final state does not depend on arrival order at all (only on the set of events)', () => {
    const a = live(shuffle(all, 1)).state
    const b = live(shuffle(all, 2)).state
    const strip = (s: CarState) => ({ ...s, outOfOrderEvents: 0, lateEvents: 0 })
    expect(strip(a)).toEqual(strip(b))
  })
})
