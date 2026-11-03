import { describe, expect, it } from 'vitest'
import { computeWatermarks } from './watermark.js'
import { bucketsFor, HOUR, isAligned, localDate, shiftBack } from './time.js'
import { planWindow } from '../api/services/planner.js'

const LA = 'America/Los_Angeles'
const KOLKATA = 'Asia/Kolkata'

describe('local-day buckets', () => {
  it('gives the DST-end day 25 hours in Los Angeles', () => {
    const from = Date.parse('2026-10-31T07:00:00Z') // Oct 31 00:00 PDT
    const to = Date.parse('2026-11-02T08:00:00Z') // Nov 2 00:00 PST
    const days = bucketsFor(from, to, 'day', LA)
    expect(days.map((d) => d.key)).toEqual(['2026-10-31', '2026-11-01'])
    expect((days[1].end - days[1].start) / HOUR).toBe(25)
  })

  it('starts Kolkata days at 18:30 UTC', () => {
    const [day] = bucketsFor(Date.parse('2026-10-28T18:30:00Z'), Date.parse('2026-10-29T18:30:00Z'), 'day', KOLKATA)
    expect(day.key).toBe('2026-10-29')
    expect(isAligned(Date.parse('2026-10-28T18:30:00Z'), 'day', KOLKATA)).toBe(true)
    expect(isAligned(Date.parse('2026-10-28T18:00:00Z'), 'day', KOLKATA)).toBe(false)
    expect(localDate(Date.parse('2026-10-28T18:29:59Z'), KOLKATA)).toBe('2026-10-28')
  })
})

describe('hour buckets in a half-hour zone', () => {
  it('clips the UTC-aligned hours at the edges of a Kolkata day instead of rejecting it', () => {
    const from = Date.parse('2026-11-02T18:30:00Z') // Nov 3 00:00 IST
    const to = Date.parse('2026-11-03T18:30:00Z')
    expect(isAligned(from, 'hour', KOLKATA)).toBe(true)
    const hours = bucketsFor(from, to, 'hour', KOLKATA)
    expect(hours).toHaveLength(25)
    expect(hours[0]).toMatchObject({ start: from, end: Date.parse('2026-11-02T19:00:00Z'), clipped: true })
    expect(hours[1].clipped).toBeUndefined()
    expect(hours[24]).toMatchObject({ start: Date.parse('2026-11-03T18:00:00Z'), end: to, clipped: true })
    expect(hours.reduce((sum, h) => sum + (h.end - h.start), 0)).toBe(24 * HOUR)
  })
})

describe('comparison shifts', () => {
  it('compares Monday 09:00 with the previous Monday 09:00 across the DST change', () => {
    const mondayPst = Date.parse('2026-11-02T17:00:00Z') // Mon 09:00 PST
    const prev = shiftBack(mondayPst, 'wow', LA)
    expect(new Date(prev).toISOString()).toBe('2026-10-26T16:00:00.000Z') // Mon 09:00 PDT: 167 elapsed hours, not 168
  })

  it('clamps month-over-month at the end of a month', () => {
    const mar31 = Date.parse('2026-03-31T07:00:00Z') // Mar 31 00:00 PDT
    expect(localDate(shiftBack(mar31, 'mom', LA), LA)).toBe('2026-02-28')
  })
})

describe('window planner', () => {
  const now = Date.parse('2026-11-02T23:00:00Z')
  const opts = { now, minuteRetentionMs: 2 * 86_400_000 }

  it('uses whole local days, then hours, then minutes and raw edges, with no gaps or overlaps', () => {
    // From Kolkata midnight (18:30 UTC) to 04:12:30 IST on Nov 3.
    const from = Date.parse('2026-10-29T18:30:00Z')
    const to = Date.parse('2026-11-02T22:42:30Z')
    expect(planWindow(from, to, KOLKATA, opts)).toEqual([
      { source: 'day', fromDate: '2026-10-30', toDate: '2026-11-03' },
      // Nov 3 local so far: 18:30 → 22:42:30 UTC.
      { source: 'hour', from: Date.parse('2026-11-02T19:00:00Z'), to: Date.parse('2026-11-02T22:00:00Z') },
      { source: 'minute', from: Date.parse('2026-11-02T18:30:00Z'), to: Date.parse('2026-11-02T19:00:00Z') },
      { source: 'minute', from: Date.parse('2026-11-02T22:00:00Z'), to: Date.parse('2026-11-02T22:42:00Z') },
      { source: 'raw', from: Date.parse('2026-11-02T22:42:00Z'), to },
    ])
  })

  it('falls back to raw events where minute rollups have expired', () => {
    const from = Date.parse('2026-10-20T10:15:00Z')
    const to = Date.parse('2026-10-20T12:30:00Z')
    expect(planWindow(from, to, LA, opts)).toEqual([
      { source: 'hour', from: Date.parse('2026-10-20T11:00:00Z'), to: Date.parse('2026-10-20T12:00:00Z') },
      { source: 'raw', from, to: Date.parse('2026-10-20T11:00:00Z') },
      { source: 'raw', from: Date.parse('2026-10-20T12:00:00Z'), to },
    ])
  })
})

describe('watermarks', () => {
  const allowance = { client: 600_000, server: 60_000 }
  const now = 1_000_000_000

  it('is bounded by the slowest partition, minus each stream allowance', () => {
    const r = computeWatermarks(
      { '0': { position: now, updatedAt: now }, '1': { position: now - 300_000, updatedAt: now, lag: 40 }, '2': { position: now, updatedAt: now } },
      3,
      now,
      allowance,
      30_000,
    )
    expect(r.processedThrough).toBe(now - 300_000)
    expect(r.watermarks).toEqual({ client: now - 900_000, server: now - 360_000 })
    expect(r.totalLag).toBe(40)
  })

  it('is unknown until every partition has reported, and reports stalled owners', () => {
    expect(computeWatermarks({ '0': { position: now, updatedAt: now } }, 3, now, allowance, 30_000).watermarks).toEqual({ client: null, server: null })
    const stalled = computeWatermarks(
      { '0': { position: now - 90_000, updatedAt: now - 90_000 }, '1': { position: now, updatedAt: now }, '2': { position: now, updatedAt: now } },
      3,
      now,
      allowance,
      30_000,
    )
    expect(stalled.stalled).toEqual([0])
    expect(stalled.processedThrough).toBe(now - 90_000)
  })
})
