/**
 * Catch-up from the event store: apply a projection's events straight from
 * PostgreSQL in global order, instead of from the broker. Used by the seed (to
 * bootstrap projections with history) and by the replay tool (to rebuild a
 * projection into shadow tables from position 0).
 * @module events/catchup
 */
import type { Queryable } from '../shared/db.js'
import { streamKey } from '../shared/stream.js'
import { PROJECTORS } from '../workers/projections/index.js'
import { toEnvelope, type StoredEventRow } from './envelope.js'
import { groupSpec } from './topology.js'

/** Events a group handles, in global order, optionally bounded per family by checkpoint positions. */
export async function eventsFor(db: Queryable, group: string, upTo?: Map<string, number>): Promise<StoredEventRow[]> {
  const spec = groupSpec(group)
  if (!spec) throw new Error(`unknown group ${group}`)
  const { rows } = await db.query<StoredEventRow>('SELECT * FROM events WHERE type = ANY($1) AND family = ANY($2) ORDER BY global_position', [spec.handles, spec.families])
  return upTo ? rows.filter((r) => Number(r.global_position) <= (upTo.get(r.family) ?? 0)) : rows
}

/** Applies events to whatever tables `db`'s search_path resolves (public, or a replay schema). */
export async function applyEvents(db: Queryable, group: string, rows: StoredEventRow[]): Promise<number> {
  const apply = PROJECTORS[group]
  if (!apply) throw new Error(`${group} is not a projection`)
  for (const row of rows) await apply(db, toEnvelope(row))
  return rows.length
}

/** Records that a group has applied these events (per broker stream), as the live consumer would. */
export async function writeCheckpoints(db: Queryable, group: string, rows: StoredEventRow[]): Promise<void> {
  const byFamily = new Map<string, { last: number; n: number }>()
  for (const r of rows) {
    const cur = byFamily.get(r.family) ?? { last: 0, n: 0 }
    byFamily.set(r.family, { last: Math.max(cur.last, Number(r.global_position)), n: cur.n + 1 })
  }
  for (const [family, { last, n }] of byFamily) {
    await db.query(
      `INSERT INTO consumer_checkpoints (group_name, stream_key, last_position, events_handled, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (group_name, stream_key) DO UPDATE SET last_position = GREATEST(consumer_checkpoints.last_position, EXCLUDED.last_position),
         events_handled = consumer_checkpoints.events_handled + EXCLUDED.events_handled, updated_at = now()`,
      [group, streamKey(family), last, n],
    )
  }
}
