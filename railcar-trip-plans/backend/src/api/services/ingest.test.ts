import { describe, expect, it } from 'vitest'
import { validateBatch } from './ingest.js'

const now = Date.parse('2026-11-04T12:00:00.000Z')
const base = { eventId: '6f1c1f7e-8d55-4f53-9a35-1f6f1c1f7e8d', occurredAt: '2026-11-04T11:00:00.000Z', producer: 'aei:AEI-NGTMID' }

describe('ingest validation', () => {
  it('accepts a v1 fact from an old reader and a v2 fact from a new one', () => {
    const { valid, results } = validateBatch(
      [
        { ...base, type: 'CarSighted', version: 1, payload: { carId: 'HPSX1', siteId: 'AEI-NGTMID' } },
        { ...base, eventId: '7f1c1f7e-8d55-4f53-9a35-1f6f1c1f7e8d', type: 'CarSighted', version: 2, payload: { carId: 'HPSX1', siteId: 'AEI-MIDPRT', readerConfidence: 0.95, orientation: 'B_END_LEADING' } },
      ],
      now,
    )
    expect(valid).toHaveLength(2)
    expect(results.filter(Boolean)).toHaveLength(0)
    expect(valid[0].event.version).toBe(1)
  })

  it('accepts late facts: lateness is not a reason to reject something that happened', () => {
    const { valid } = validateBatch([{ ...base, occurredAt: '2026-11-03T01:00:00.000Z', type: 'CarInterchanged', version: 1, payload: { carId: 'LPSX990001', interchangePoint: 'SDV', direction: 'received', fromRoad: 'LPS', toRoad: 'PN' } }], now)
    expect(valid).toHaveLength(1)
  })

  it('rejects decisions posted as facts, unknown types and unknown versions', () => {
    const { results } = validateBatch(
      [
        { ...base, type: 'ConnectionMissed', version: 1, payload: {} },
        { ...base, type: 'CarTeleported', version: 1, payload: {} },
        { ...base, type: 'CarSighted', version: 3, payload: { carId: 'HPSX1', siteId: 'X' } },
      ],
      now,
    )
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(results[2].error).toContain('not a known schema version')
  })

  it('rejects malformed payloads and events from the future', () => {
    const { results } = validateBatch(
      [
        { ...base, type: 'CarArrivedYard', version: 1, payload: { yardId: 'MID' } },
        { ...base, occurredAt: '2026-11-04T13:00:00.000Z', type: 'CarArrivedYard', version: 1, payload: { carId: 'HPSX1', yardId: 'MID' } },
        { nonsense: true },
      ],
      now,
    )
    expect(results[0].error).toContain('carId')
    expect(results[1].error).toContain('future')
    expect(results[2].status).toBe('rejected')
  })
})
