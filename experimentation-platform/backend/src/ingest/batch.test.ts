import { describe, expect, it } from 'vitest'
import { batchEnvelopeSchema, chTime, insertToken, prepareBatch, toClickHouseRows } from './batch.js'

const limits = { maxEventAgeMs: 30 * 86_400_000, maxFutureMs: 86_400_000 }
const now = Date.UTC(2026, 10, 6, 12, 0, 0)
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function exposure(n: number, ts: number) {
  return { type: 'exposure', eventId: uuid(n), ts, flagKey: 'checkout_cta', flagVersion: 2, variant: 'treatment', unitType: 'user', unitId: 'anon-1', anonymousId: 'anon-1' }
}

describe('prepareBatch', () => {
  it('corrects device clock skew with the batch sentAt', () => {
    // Device clock 10 minutes slow: it thinks it is 11:50 when the server says 12:00.
    const deviceNow = now - 10 * 60_000
    const env = batchEnvelopeSchema.parse({ batchId: 'batch-0001', sentAt: deviceNow, events: [exposure(1, deviceNow - 5_000)] })
    const { batch, rejected } = prepareBatch(env, 'prod', now, limits)
    expect(rejected).toEqual([])
    expect(batch.skewMs).toBe(10 * 60_000)
    expect(batch.events[0].ts).toBe(now - 5_000)
    expect(batch.events[0].clientTs).toBe(deviceNow - 5_000)
  })

  it('keeps late events within the analysis horizon and rejects older or malformed ones', () => {
    const env = batchEnvelopeSchema.parse({
      batchId: 'batch-0002',
      sentAt: now,
      events: [exposure(1, now - 6 * 3_600_000), exposure(2, now - 40 * 86_400_000), { type: 'exposure', eventId: 'not-a-uuid' }, exposure(1, now)],
    })
    const { batch, rejected } = prepareBatch(env, 'prod', now, limits)
    expect(batch.events.map((e) => e.event.eventId)).toEqual([uuid(1)])
    expect(rejected.map((r) => r.reason)).toEqual(['too old to analyze', expect.stringMatching(/uuid/i), 'duplicate event id in batch'])
  })

  it('maps events to ClickHouse rows; conversions carry the stable id they will be attributed by', () => {
    const env = batchEnvelopeSchema.parse({
      batchId: 'batch-0003',
      sentAt: now,
      sdkInstanceId: 'sdk-1',
      events: [exposure(1, now), { type: 'conversion', eventId: uuid(2), ts: now, name: 'purchase', value: 42, anonymousId: 'anon-9' }],
    })
    const rows = toClickHouseRows([prepareBatch(env, 'prod', now, limits).batch])
    expect(rows.exposures).toHaveLength(1)
    expect(rows.exposures[0]).toMatchObject({ flag_key: 'checkout_cta', unit_id: 'anon-1', ts: chTime(now), sdk_instance: 'sdk-1' })
    expect(rows.conversions[0]).toMatchObject({ event_name: 'purchase', value: 42, stable_id: 'anon-9' })
    expect(chTime(now)).toBe('2026-11-06 12:00:00.000')
  })
})

describe('insertToken', () => {
  it('is stable for the same entries and differs per table and per grouping', () => {
    expect(insertToken('exposures', ['1-0', '2-0'])).toBe(insertToken('exposures', ['1-0', '2-0']))
    expect(insertToken('exposures', ['1-0', '2-0'])).not.toBe(insertToken('conversions', ['1-0', '2-0']))
    expect(insertToken('exposures', ['1-0', '2-0'])).not.toBe(insertToken('exposures', ['1-0']))
  })
})
