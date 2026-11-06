import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { parseEvent, type AnyDomainEvent } from '../shared/events.js'
import { applyLive, bucketFor, deltasFor, diffStates, emptyState, foldEvents, histogramPercentile } from './analytics.js'

function envelope(type: string, version: number, occurredAt: string, payload: Record<string, unknown>) {
  return parseEvent({
    event_id: randomUUID(),
    type,
    version,
    occurred_at: occurredAt,
    recorded_at: new Date().toISOString(),
    stream_id: `quote-${randomUUID()}`,
    stream_version: 1,
    correlation_id: 'c',
    causation_id: null,
    producer: 'test',
    payload,
  })
}

const quoteId = () => randomUUID()

function sampleEvents(): AnyDomainEvent[] {
  const out: AnyDomainEvent[] = []
  for (let i = 0; i < 40; i += 1) {
    const at = new Date(Date.UTC(2026, 10, 5, 8 + (i % 5), i)).toISOString()
    const id = quoteId()
    out.push(
      envelope('QuoteRequested', 1, at, {
        quote_id: id, customer_id: 'CUST-GPX', client_class: i % 3 === 0 ? 'api_requote' : 'api', origin: 'HOU', destination: 'CHI', commodity: 'PLASTIC',
        equipment: 'COVERED_HOPPER', quantity: 5, ship_week: '2026-11-16', idempotency_key: `k${i}`, deadline_ms: 900, needs_firm: i % 4 === 0,
      }),
    )
    const base = { quote_id: id, customer_id: 'CUST-GPX', kind: i % 4 === 0 ? 'indicative' : 'firm', revision: 1, total_cents: 100, currency: 'USD', valid_until: at, tariff_version: 'v7', surcharge_date: '2026-11-02' }
    out.push(
      i < 10
        ? envelope('QuoteIssued', 1, at, base)
        : envelope('QuoteIssued', 2, at, {
            ...base, reason: 'initial', client_class: 'api', latency_ms: 100 + i * 10,
            price_components: [
              { component: 'linehaul', dependency: 'pricing', source: i % 2 ? 'cache' : 'live', version: 'tariff:v7', as_of: at, age_seconds: 0, latency_ms: i % 2 ? null : 50 + i, amount_cents_per_car: 90 },
              { component: 'capacity_premium', dependency: 'capacity', source: i % 4 === 0 ? 'fallback' : 'live', version: null, as_of: at, age_seconds: 0, latency_ms: i % 4 === 0 ? null : 100 + i * 20, amount_cents_per_car: 0 },
            ],
          }),
    )
    if (i % 5 === 0) out.push(envelope('QuoteBooked', 1, at, { quote_id: id, booking_id: randomUUID(), customer_id: 'CUST-GPX', kind: 'firm', honored_total_cents: 100, honored_tariff_version: 'v7', current_tariff_version: 'v8' }))
  }
  return out
}

function shuffle<T>(xs: T[], seed = 7): T[] {
  const out = [...xs]
  let s = seed
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 9301 + 49297) % 233280
    const j = Math.floor((s / 233280) * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe('analytics projection', () => {
  it('replay from position 0 equals live application in any order, with duplicates', () => {
    const events = sampleEvents()
    const replay = foldEvents(events)
    // "Live": delivered out of order across partitions, with every fifth event redelivered.
    const delivered = shuffle([...events, ...events.filter((_, i) => i % 5 === 0)])
    const live = foldEvents(delivered)
    expect(diffStates(replay, live)).toEqual([])
    expect(replay.counters.size).toBeGreaterThan(0)
  })

  it('buckets by event time, so a late event lands in the hour it happened', () => {
    const late = envelope('QuoteExpired', 1, '2026-11-05T03:59:59.000Z', { quote_id: quoteId(), customer_id: 'C', kind: 'firm', valid_until: '2026-11-05T03:59:59.000Z' })
    const [delta] = deltasFor(late)
    expect(delta).toMatchObject({ kind: 'counter', bucket: '2026-11-05T03:00:00.000Z', metric: 'expired' })
  })

  it('counts upcast v1 events but takes no latency from them', () => {
    const v1 = sampleEvents().filter((e) => e.type === 'QuoteIssued' && e.storedVersion === 1)
    const state = foldEvents(v1)
    expect([...state.latency.keys()]).toEqual([])
    expect([...state.sources.keys()].every((k) => k.endsWith('|unknown'))).toBe(true)
  })

  it('computes percentiles from the histogram buckets', () => {
    expect(bucketFor(42)).toBe(50)
    expect(histogramPercentile([{ le: 50, count: 98 }, { le: 1_500, count: 2 }], 99)).toBe(1_500)
    expect(histogramPercentile([{ le: 50, count: 99 }, { le: 1_500, count: 1 }], 99)).toBe(50)
    expect(histogramPercentile([], 99)).toBeNull()
  })

  it('makes a redelivered event a no-op in the live projector (processed_events guard)', async () => {
    const seen = new Set<string>()
    const writes: string[] = []
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO processed_events')) {
          const id = params[1] as string
          if (seen.has(id)) return { rowCount: 0, rows: [] }
          seen.add(id)
          return { rowCount: 1, rows: [] }
        }
        writes.push(sql.trim().split(/\s+/).slice(0, 3).join(' '))
        return { rowCount: 1, rows: [] }
      }),
    } as unknown as pg.PoolClient
    const event = sampleEvents()[0]
    expect(await applyLive(client, event, 1)).toBe(true)
    const afterFirst = writes.length
    expect(await applyLive(client, event, 1)).toBe(false)
    expect(writes.length).toBe(afterFirst)
    expect(emptyState().counters.size).toBe(0)
  })
})
