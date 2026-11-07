/**
 * Test fixtures: envelopes and a small trip (Northgate → Midland → Port) used across unit tests.
 */
import type { AnyEnvelope } from '../shared/events/envelope.js'
import type { EventType, Leg, Payloads } from '../shared/events/schemas.js'
import { upcastPayload } from '../shared/events/upcasters.js'

let counter = 0

export function ev<T extends EventType>(type: T, occurredAt: string, payload: Payloads[T] | Record<string, unknown>, opts: { position?: number; recordedAt?: string; producer?: string; version?: number; eventId?: string } = {}): AnyEnvelope {
  counter += 1
  const version = opts.version ?? 1
  const up = upcastPayload(type, version, payload as Record<string, unknown>)
  const topic = type.startsWith('Train') ? 'train' : 'car'
  const p = payload as { carId?: string; runId?: string }
  return {
    eventId: opts.eventId ?? `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    type,
    version: up.version,
    upcastFrom: up.upcastFrom,
    streamId: `${topic}-${p.carId ?? p.runId}`,
    streamVersion: 1,
    position: opts.position ?? counter,
    topic,
    partitionKey: (p.carId ?? p.runId)!,
    occurredAt,
    recordedAt: opts.recordedAt ?? occurredAt,
    correlationId: '00000000-0000-4000-8000-000000000000',
    causationId: null,
    producer: opts.producer ?? (topic === 'train' ? 'tms:dispatch' : 'yard:NGT'),
    payload: up.payload,
  } as AnyEnvelope
}

export const CAR = 'HPSX104300'

export const LEGS: Leg[] = [
  { seq: 0, trainId: 'M-NGTMID', runId: 'M-NGTMID-20261104', fromYard: 'NGT', toYard: 'MID', plannedDeparture: '2026-11-04T04:00:00.000Z', plannedArrival: '2026-11-04T12:00:00.000Z' },
  { seq: 1, trainId: 'M-MIDPRT', runId: 'M-MIDPRT-20261104', fromYard: 'MID', toYard: 'PRT', plannedDeparture: '2026-11-04T20:00:00.000Z', plannedArrival: '2026-11-05T06:00:00.000Z' },
]

export function planCreated(position = 1): AnyEnvelope {
  return ev(
    'TripPlanCreated',
    '2026-11-03T10:00:00.000Z',
    {
      tripId: `T-${CAR}`, carId: CAR, shipperId: 'S01', originYard: 'NGT', destinationYard: 'PRT', destinationCustomer: 'PRT-EXPORT-1', handoffRoad: null,
      releasedAt: '2026-11-03T10:00:00.000Z', version: 1, legs: LEGS, reason: { code: 'initial', text: 'Initial plan', missedRunId: null, yardId: null },
    },
    { position, producer: 'waybill-feed' },
  )
}

/** A full on-plan trip to Midland: pull, depart on the first leg, line read, arrival. */
export function tripToMidland(): AnyEnvelope[] {
  return [
    planCreated(1),
    ev('CarPulled', '2026-11-03T12:00:00.000Z', { carId: CAR, customerId: 'S01-NGT', yardId: 'NGT' }, { position: 2 }),
    ev('CarDepartedYard', '2026-11-04T03:50:00.000Z', { carId: CAR, yardId: 'NGT', trainRunId: 'M-NGTMID-20261104' }, { position: 3 }),
    ev('TrainDeparted', '2026-11-04T04:00:00.000Z', { runId: 'M-NGTMID-20261104', trainId: 'M-NGTMID', fromYard: 'NGT', toYard: 'MID', consist: [CAR, 'HPSX104301'] }, { position: 4 }),
    ev('CarSighted', '2026-11-04T07:40:00.000Z', { carId: CAR, siteId: 'AEI-NGTMID', trainRunId: 'M-NGTMID-20261104', direction: 'E', railroad: 'PN' }, { position: 5, producer: 'aei:AEI-NGTMID' }),
    ev('TrainArrived', '2026-11-04T12:10:00.000Z', { runId: 'M-NGTMID-20261104', trainId: 'M-NGTMID', yardId: 'MID' }, { position: 6 }),
    ev('CarArrivedYard', '2026-11-04T12:30:00.000Z', { carId: CAR, yardId: 'MID', trainRunId: 'M-NGTMID-20261104', track: 'R3' }, { position: 7, producer: 'yard:MID' }),
  ]
}

export function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
