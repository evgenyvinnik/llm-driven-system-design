import { describe, expect, it } from 'vitest'
import { MemoryDedupStore, prepareEvent, processBatch, type BatchMessage, type PrepareContext } from './pipeline.js'

const ORGS = new Map([
  ['larkspur', { timeZone: 'America/Los_Angeles' }],
  ['kestrel', { timeZone: 'Asia/Kolkata' }],
])
const PRICES = [{ model: 'orion-swift', effectiveFrom: 0, inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 4_000_000 }]

function ctx(watermarks: PrepareContext['watermarks'] = { client: null, server: null }): PrepareContext {
  return { orgs: ORGS, prices: PRICES, watermarks, maxLatenessMs: 72 * 3_600_000, maxClockSkewMs: 60_000 }
}

let n = 0
function event(overrides: Record<string, unknown> = {}) {
  n++
  return {
    event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    schema_version: 1,
    event_type: 'conversation_started',
    source: 'client',
    org_id: 'larkspur',
    user_id: 'u_abc',
    conversation_id: 'c_1',
    model: 'orion-swift',
    feature: 'chat',
    event_time: '2026-10-29T18:00:00.000Z',
    received_time: '2026-10-29T18:00:01.000Z',
    ...overrides,
  }
}

const msg = (offset: number, value: unknown, partition = 0): BatchMessage => ({ partition, offset: String(offset), value: JSON.stringify(value) })

describe('dedup by event_id', () => {
  it('drops a second copy of an event in the same batch', async () => {
    const e = event()
    const result = await processBatch([msg(0, e), msg(1, e)], { dedup: new MemoryDedupStore(), ctx: ctx(), insertedThrough: -1 })
    expect(result.rows).toHaveLength(1)
    expect(result.duplicates).toBe(1)
  })

  it('drops a copy that arrives in a later batch, from a different offset', async () => {
    const dedup = new MemoryDedupStore()
    const e = event()
    await processBatch([msg(10, e)], { dedup, ctx: ctx(), insertedThrough: -1 })
    const retry = await processBatch([msg(57, { ...e, received_time: '2026-10-29T18:05:00.000Z' })], { dedup, ctx: ctx(), insertedThrough: 10 })
    expect(retry.rows).toHaveLength(0)
    expect(retry.duplicates).toBe(1)
  })

  it('keeps a message Kafka redelivers after a crash: its claim is its own', async () => {
    const dedup = new MemoryDedupStore()
    const e = event()
    const first = await processBatch([msg(5, e, 2)], { dedup, ctx: ctx(), insertedThrough: -1 })
    // Crash before the insert: inserted-through never advanced, the same offset comes back.
    const again = await processBatch([msg(5, e, 2)], { dedup, ctx: ctx(), insertedThrough: -1 })
    expect(first.rows).toHaveLength(1)
    expect(again.rows).toHaveLength(1)
    expect(again.duplicates).toBe(0)
  })

  it('skips offsets already written to ClickHouse before a crash', async () => {
    const result = await processBatch([msg(3, event()), msg(4, event()), msg(5, event())], { dedup: new MemoryDedupStore(), ctx: ctx(), insertedThrough: 4 })
    expect(result.alreadyInserted).toBe(2)
    expect(result.rows).toHaveLength(1)
  })
})

describe('late data', () => {
  it('buckets by event time and flags events behind their stream watermark', async () => {
    const watermark = Date.parse('2026-10-30T12:00:00.000Z')
    const lateClient = event({ event_time: '2026-10-29T21:00:00.000Z', received_time: '2026-10-30T12:05:00.000Z' })
    const onTimeServer = event({
      event_type: 'response_completed',
      source: 'server',
      generation_id: 'g_1',
      ttft_ms: 400,
      latency_ms: 2100,
      input_tokens: 1000,
      output_tokens: 250,
      event_time: '2026-10-30T12:04:00.000Z',
      received_time: '2026-10-30T12:04:00.020Z',
    })
    const result = await processBatch([msg(0, lateClient), msg(1, onTimeServer)], {
      dedup: new MemoryDedupStore(),
      ctx: ctx({ client: watermark, server: watermark }),
      insertedThrough: -1,
    })
    expect(result.rows.map((r) => r.is_late)).toEqual([1, 0])
    // Yesterday afternoon in Los Angeles: the late event reopens yesterday's bucket, not today's.
    expect(result.rows[0].local_date).toBe('2026-10-29')
    expect(result.rows[0].event_time).toBe('2026-10-29 21:00:00.000')
    expect(result.lateDays.get('larkspur')).toEqual(new Set(['2026-10-29']))
  })

  it('rejects events that arrive after the buckets were sealed (72h)', () => {
    const prepared = prepareEvent(
      event({ event_time: '2026-10-20T10:00:00.000Z', received_time: '2026-10-29T10:00:00.000Z' }) as never,
      ctx(),
    )
    expect(prepared.kind).toBe('reject')
    expect(prepared.kind === 'reject' && prepared.reason).toBe('too_late')
  })

  it('re-stamps an event from a device clock running ahead', () => {
    const prepared = prepareEvent(event({ event_time: '2026-10-29T23:00:00.000Z', received_time: '2026-10-29T18:00:00.000Z' }) as never, ctx())
    expect(prepared.kind === 'accept' && prepared.row.event_time).toBe('2026-10-29 18:00:00.000')
  })
})

describe('daily buckets in the org time zone', () => {
  it('assigns the same instant to different local dates per org', () => {
    // 18:45 UTC is 00:15 the next day in Kolkata (UTC+5:30) and 10:45 in Los Angeles (PST, after DST ended on Nov 1).
    const instant = { event_time: '2026-11-01T18:45:00.000Z', received_time: '2026-11-01T18:45:01.000Z' }
    const kestrel = prepareEvent(event({ ...instant, org_id: 'kestrel' }) as never, ctx())
    const larkspur = prepareEvent(event({ ...instant, org_id: 'larkspur' }) as never, ctx())
    expect(kestrel.kind === 'accept' && kestrel.row.local_date).toBe('2026-11-02')
    expect(larkspur.kind === 'accept' && larkspur.row.local_date).toBe('2026-11-01')
  })

  it('keeps a late-evening Pacific event on its local day although the UTC date has rolled over', () => {
    const p = prepareEvent(event({ event_time: '2026-11-03T07:30:00.000Z', received_time: '2026-11-03T07:30:02.000Z' }) as never, ctx())
    expect(p.kind === 'accept' && p.row.local_date).toBe('2026-11-02')
  })
})

describe('contract and privacy', () => {
  it('rejects an event carrying message content, before any other check', async () => {
    const result = await processBatch([msg(0, { ...event(), content: 'my medical question' })], { dedup: new MemoryDedupStore(), ctx: ctx(), insertedThrough: -1 })
    expect(result.rows).toHaveLength(0)
    expect(result.rejected[0].reason).toBe('content_field')
    // The rejected row keeps metadata only: nothing of the payload.
    expect(JSON.stringify(result.rejected[0])).not.toContain('medical')
  })

  it('rejects unknown fields and wrong sources', async () => {
    const result = await processBatch(
      [msg(0, { ...event(), referrer: 'x' }), msg(1, event({ source: 'server' })), { partition: 0, offset: '2', value: 'not json' }, msg(3, event({ org_id: 'nobody' }))],
      { dedup: new MemoryDedupStore(), ctx: ctx(), insertedThrough: -1 },
    )
    expect(result.rejected.map((r) => r.reason)).toEqual(['schema', 'schema', 'invalid_json', 'unknown_org'])
  })

  it('prices tokens at ingest', () => {
    const p = prepareEvent(
      event({ event_type: 'response_completed', source: 'server', generation_id: 'g', ttft_ms: 1, latency_ms: 2, input_tokens: 2000, output_tokens: 500 }) as never,
      ctx(),
    )
    // 2000 × $1/M + 500 × $4/M = $0.004 = 4000 micros
    expect(p.kind === 'accept' && p.row.cost_micros).toBe(4000)
  })
})
