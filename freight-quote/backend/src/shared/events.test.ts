import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildEnvelope, InvalidEventError, parseEvent, UnknownSchemaError } from './events.js'
import { decide } from './consumer.js'
import { eventFromFields } from './monitor.js'

const v1Issued = () => ({
  event_id: randomUUID(),
  type: 'QuoteIssued',
  version: 1,
  occurred_at: '2026-11-03T10:00:00.000Z',
  recorded_at: '2026-11-03T10:00:00.050Z',
  stream_id: 'quote-x',
  stream_version: 2,
  correlation_id: 'corr-1',
  causation_id: null,
  producer: 'quote-api@2026.2',
  payload: {
    quote_id: randomUUID(),
    customer_id: 'CUST-PGC',
    kind: 'firm',
    revision: 1,
    total_cents: 1_549_000,
    currency: 'USD',
    valid_until: '2026-11-04T10:00:00.000Z',
    tariff_version: 'v7',
    surcharge_date: '2026-11-02',
  },
})

describe('event envelope and schema evolution', () => {
  it('upcasts QuoteIssued v1 to v2 with synthesized provenance', () => {
    const e = parseEvent(v1Issued())
    expect(e.type).toBe('QuoteIssued')
    expect(e.version).toBe(2)
    expect(e.storedVersion).toBe(1)
    if (e.type !== 'QuoteIssued') throw new Error('narrowing')
    expect(e.payload.reason).toBe('unknown')
    expect(e.payload.latency_ms).toBeNull()
    expect(e.payload.price_components).toHaveLength(2)
    expect(e.payload.price_components[0]).toMatchObject({ dependency: 'pricing', source: 'unknown', version: 'v7', latency_ms: null })
    expect(e.payload.price_components[1]).toMatchObject({ dependency: 'fuel', version: 'fsc:2026-11-02' })
  })

  it('passes v2 through unchanged', () => {
    const raw = v1Issued()
    const v2 = { ...raw, version: 2, payload: { ...raw.payload, reason: 'initial', client_class: 'portal', latency_ms: 140, price_components: [] } }
    const e = parseEvent(v2)
    expect(e.storedVersion).toBe(2)
    expect(e.payload).toMatchObject({ reason: 'initial', latency_ms: 140 })
  })

  it('rejects unknown types and versions as permanent errors that go straight to the DLQ', () => {
    const unknownVersion = { ...v1Issued(), version: 9 }
    expect(() => parseEvent(unknownVersion)).toThrow(UnknownSchemaError)
    const unknownType = { ...v1Issued(), type: 'QuoteTeleported' }
    expect(() => parseEvent(unknownType)).toThrow(UnknownSchemaError)
    try {
      parseEvent(unknownVersion)
    } catch (err) {
      expect(decide(err, 1)).toBe('dead_letter')
    }
  })

  it('rejects a payload that does not match its schema', () => {
    const bad = v1Issued()
    ;(bad.payload as Record<string, unknown>).total_cents = 'a lot'
    expect(() => parseEvent(bad)).toThrow(InvalidEventError)
  })

  it('treats an unparseable stream message as poison', () => {
    let err: unknown
    try {
      eventFromFields({ event: '{"not json' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(InvalidEventError)
    expect(decide(err, 1)).toBe('dead_letter')
  })

  it('builds envelopes at the latest version with event and processing time', () => {
    const occurred = new Date('2026-11-05T08:00:00Z')
    const env = buildEnvelope(
      {
        type: 'DependencyCircuitOpened',
        streamId: 'dependency-capacity',
        correlationId: 'c',
        occurredAt: occurred,
        payload: { dependency: 'capacity', instance_id: 'api-1', reason: 'errors' },
      },
      'quote-api',
      new Date('2026-11-05T08:00:01Z'),
    )
    expect(env.version).toBe(1)
    expect(env.occurred_at).toBe('2026-11-05T08:00:00.000Z')
    expect(env.recorded_at).toBe('2026-11-05T08:00:01.000Z')
    expect(() => buildEnvelope({ type: 'QuoteIssued', streamId: 's', correlationId: 'c', payload: {} as never }, 'x')).toThrow()
  })
})
