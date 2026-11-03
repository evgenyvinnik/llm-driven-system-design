/**
 * Splits an arbitrary time window into pieces that can each be answered from
 * the coarsest table that fits: whole org-local days from the daily rollup,
 * whole UTC hours from the hourly rollup, whole minutes from the minute
 * rollup (while it is retained), and any ragged edge from raw events.
 *
 * Because every piece yields mergeable states (sums, HyperLogLog, t-digest),
 * the pieces combine into one exact-as-the-sketches answer. This is what lets
 * "this week so far" be compared with "last week up to the same moment" in a
 * half-hour time zone, where local midnight is not a UTC hour boundary.
 * @module api/services/planner
 */
import { DateTime } from 'luxon'
import { HOUR, MINUTE } from '../../shared/time.js'

export type Piece =
  | { source: 'day'; fromDate: string; toDate: string }
  | { source: 'hour'; from: number; to: number }
  | { source: 'minute'; from: number; to: number }
  | { source: 'raw'; from: number; to: number }

export interface PlanOptions {
  now: number
  /** Minute rollups older than this are gone (TTL), so edges fall back to raw events. */
  minuteRetentionMs: number
}

function firstLocalMidnightAtOrAfter(t: number, tz: string): number {
  const start = DateTime.fromMillis(t, { zone: tz }).startOf('day')
  return start.toMillis() === t ? t : start.plus({ days: 1 }).toMillis()
}

function lastLocalMidnightAtOrBefore(t: number, tz: string): number {
  return DateTime.fromMillis(t, { zone: tz }).startOf('day').toMillis()
}

function splitSubDay(from: number, to: number, opts: PlanOptions): Piece[] {
  if (from >= to) return []
  const pieces: Piece[] = []
  const h0 = Math.ceil(from / HOUR) * HOUR
  const h1 = Math.floor(to / HOUR) * HOUR
  const edges: [number, number][] = []
  if (h0 < h1) {
    pieces.push({ source: 'hour', from: h0, to: h1 })
    edges.push([from, h0], [h1, to])
  } else {
    edges.push([from, to])
  }
  for (const [s, e] of edges) {
    if (s >= e) continue
    const m0 = Math.ceil(s / MINUTE) * MINUTE
    const m1 = Math.floor(e / MINUTE) * MINUTE
    if (m0 < m1 && m0 >= opts.now - opts.minuteRetentionMs) {
      pieces.push({ source: 'minute', from: m0, to: m1 })
      if (s < m0) pieces.push({ source: 'raw', from: s, to: m0 })
      if (m1 < e) pieces.push({ source: 'raw', from: m1, to: e })
    } else {
      pieces.push({ source: 'raw', from: s, to: e })
    }
  }
  return pieces
}

export function planWindow(from: number, to: number, timeZone: string, opts: PlanOptions): Piece[] {
  if (from >= to) return []
  const d0 = firstLocalMidnightAtOrAfter(from, timeZone)
  const d1 = lastLocalMidnightAtOrBefore(to, timeZone)
  if (d0 >= d1) return splitSubDay(from, to, opts)
  return [
    ...splitSubDay(from, d0, opts),
    {
      source: 'day',
      fromDate: DateTime.fromMillis(d0, { zone: timeZone }).toISODate()!,
      toDate: DateTime.fromMillis(d1, { zone: timeZone }).toISODate()!,
    },
    ...splitSubDay(d1, to, opts),
  ]
}
