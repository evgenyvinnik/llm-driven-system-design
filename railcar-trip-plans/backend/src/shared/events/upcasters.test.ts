import { describe, expect, it } from 'vitest'
import { parsePayload, UnsupportedVersionError } from './schemas.js'
import { upcastPayload } from './upcasters.js'
import { toEnvelope } from './envelope.js'

const v1 = { carId: 'HPSX104300', siteId: 'AEI-NGTMID', trainRunId: 'M-NGTMID-20261104', direction: 'E', railroad: 'PN' }

describe('schema evolution: CarSighted v1 → v2', () => {
  it('upcasts a v1 payload to v2 with honest defaults (unknown, not invented)', () => {
    const up = upcastPayload('CarSighted', 1, v1)
    expect(up.version).toBe(2)
    expect(up.upcastFrom).toBe(1)
    expect(up.payload).toEqual({ ...v1, readerConfidence: null, orientation: 'UNKNOWN' })
    // The upcast payload is a valid v2 payload.
    expect(() => parsePayload('CarSighted', 2, up.payload)).not.toThrow()
  })

  it('passes a v2 payload through untouched', () => {
    const v2 = { ...v1, readerConfidence: 0.97, orientation: 'A_END_LEADING' }
    const up = upcastPayload('CarSighted', 2, v2)
    expect(up).toEqual({ version: 2, payload: v2, upcastFrom: null })
  })

  it('rejects a version newer than the consumer knows (so it is retried, then dead-lettered)', () => {
    expect(() => upcastPayload('CarSighted', 3, v1)).toThrow(UnsupportedVersionError)
    expect(() => parsePayload('CarSighted', 3, v1)).toThrow(UnsupportedVersionError)
  })

  it('validates each version against its own schema', () => {
    expect(() => parsePayload('CarSighted', 1, v1)).not.toThrow()
    expect(() => parsePayload('CarSighted', 2, v1)).toThrow() // v2 requires the new fields
    expect(parsePayload('CarSighted', 1, { carId: 'X1', siteId: 'S' })).toMatchObject({ trainRunId: null, railroad: 'PN' })
  })

  it('upcasts when a stored row becomes an envelope, keeping the produced version visible', () => {
    const env = toEnvelope({
      position: 9, event_id: 'e', type: 'CarSighted', version: 1, stream_id: 'car-HPSX104300', stream_version: 3, topic: 'car', partition_key: 'HPSX104300',
      occurred_at: '2026-11-04T07:40:00.000Z', recorded_at: '2026-11-04T07:41:00.000Z', correlation_id: 'c', causation_id: null, producer: 'aei:AEI-NGTMID', payload: v1,
    })
    expect(env.version).toBe(2)
    expect(env.upcastFrom).toBe(1)
    expect(env.type === 'CarSighted' && env.payload.orientation).toBe('UNKNOWN')
  })
})
