/**
 * Time-zone arithmetic. Storage and every bucket boundary are UTC instants; a
 * "day" is always a calendar day in the org's time zone, and comparisons shift
 * by wall-clock time in that zone (Monday 09:00 → the previous Monday 09:00),
 * so a DST change never misaligns a week-over-week chart.
 * @module shared/time
 */
import { DateTime } from 'luxon'

export type Grain = 'minute' | 'hour' | 'day'
export type Compare = 'none' | 'wow' | 'mom'

export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. Hot path in ingest, so it avoids luxon. */
export function localDate(instantMs: number, timeZone: string): string {
  let fmt = dateFormatters.get(timeZone)
  if (!fmt) {
    // en-CA formats as YYYY-MM-DD.
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dateFormatters.set(timeZone, fmt)
  }
  return fmt.format(instantMs)
}

/** UTC instant of local midnight starting the given calendar date. */
export function startOfLocalDate(date: string, timeZone: string): number {
  return DateTime.fromISO(date, { zone: timeZone }).startOf('day').toMillis()
}

export function isValidTimeZone(timeZone: string): boolean {
  return DateTime.local().setZone(timeZone).isValid
}

export interface Bucket {
  start: number
  end: number
  /** Local date for day buckets, ISO instant otherwise. Joins rollup rows to buckets. */
  key: string
  /**
   * An hour bucket cut short by the range edge. In a half-hour zone such as
   * Asia/Kolkata, "today" starts at 18:30 UTC, half-way through a UTC hour, so
   * the first and last hour buckets are clipped and are computed from minute
   * rollups or raw events instead of the hourly rollup.
   */
  clipped?: boolean
}

/**
 * Every bucket in [start, end). Day buckets are local days and can be 23 or 25
 * hours long. Hour and minute buckets are UTC-aligned (that is how they are
 * rolled up), clipped to the range at the edges.
 */
export function bucketsFor(start: number, end: number, grain: Grain, timeZone: string): Bucket[] {
  const out: Bucket[] = []
  if (grain === 'day') {
    let cursor = DateTime.fromMillis(start, { zone: timeZone }).startOf('day')
    while (cursor.toMillis() < end) {
      const next = cursor.plus({ days: 1 })
      out.push({ start: cursor.toMillis(), end: next.toMillis(), key: cursor.toISODate()! })
      cursor = next
    }
    return out
  }
  const step = grain === 'hour' ? HOUR : MINUTE
  for (let t = Math.floor(start / step) * step; t < end; t += step) {
    const s = Math.max(t, start)
    const e = Math.min(t + step, end)
    out.push({ start: s, end: e, key: new Date(s).toISOString(), ...(s !== t || e !== t + step ? { clipped: true } : {}) })
  }
  return out
}

/**
 * True when an instant can bound a range of this grain: local midnight for
 * days, any whole minute for hours and minutes (hour buckets clip at the edges).
 */
export function isAligned(instant: number, grain: Grain, timeZone: string): boolean {
  if (grain !== 'day') return instant % MINUTE === 0
  return DateTime.fromMillis(instant, { zone: timeZone }).startOf('day').toMillis() === instant
}

/** Shifts an instant back by one comparison period in local wall-clock time. */
export function shiftBack(instant: number, compare: Compare, timeZone: string): number {
  if (compare === 'none') return instant
  const local = DateTime.fromMillis(instant, { zone: timeZone })
  // luxon clamps month arithmetic: Mar 31 minus one month is Feb 28/29.
  return (compare === 'wow' ? local.minus({ weeks: 1 }) : local.minus({ months: 1 })).toMillis()
}

/** Formats an instant for ClickHouse DateTime parameters (UTC, seconds precision). */
export function toChDateTime(instant: number): string {
  return new Date(instant).toISOString().slice(0, 19).replace('T', ' ')
}
