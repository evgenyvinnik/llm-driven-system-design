/**
 * Replay of the analytics projection from position 0.
 *
 * `verifyAnalytics` folds the whole event log in memory and diffs it against
 * the live tables (read-only). `rebuildAnalytics` does the same fold and then
 * swaps the result into the live tables in one transaction. It locks the
 * projection tables *before* reading the log, so every event the live
 * projector applied earlier is in the fold. An event committed after the read
 * blocks the live projector until the swap commits, and is then applied on
 * top: its processed_events row was not in the replay set.
 * @module projector/rebuild
 */
import type pg from 'pg'
import { pool, withTransaction } from '../shared/db.js'
import { parseEvent, type AnyDomainEvent } from '../shared/events.js'
import { rowToEnvelope } from '../shared/event-store.js'
import { diffStates, emptyState, foldEvents, PROJECTION, readLiveState, type ProjectionState } from './analytics.js'

export interface ReplayResult {
  events: number
  /** Events in the log the live projector has not applied yet (lag, not a mismatch). */
  notYetApplied: number
  skipped: { position: number; reason: string }[]
  upcast: number
  maxPosition: number
  diffs: string[]
  match: boolean
  ms: number
}

async function foldLog(db: pg.PoolClient | typeof pool, onlyApplied = false): Promise<{ state: ProjectionState; ids: string[]; skipped: ReplayResult['skipped']; upcast: number; maxPosition: number; lastRecorded: string | null }> {
  const state = emptyState()
  const seen = new Set<string>()
  const skipped: ReplayResult['skipped'] = []
  let upcast = 0
  let after = 0
  let lastRecorded: string | null = null
  for (;;) {
    const { rows } = onlyApplied
      ? await db.query(
          `SELECT e.* FROM events e JOIN processed_events p ON p.consumer = $2 AND p.event_id = e.event_id
           WHERE e.position > $1 ORDER BY e.position LIMIT 2000`,
          [after, PROJECTION],
        )
      : await db.query('SELECT * FROM events WHERE position > $1 ORDER BY position LIMIT 2000', [after])
    if (rows.length === 0) break
    const batch: AnyDomainEvent[] = []
    for (const row of rows) {
      const env = rowToEnvelope(row)
      after = env.position
      try {
        const e = parseEvent(env)
        if (e.storedVersion !== e.version) upcast += 1
        batch.push(e)
        if (!lastRecorded || env.recorded_at > lastRecorded) lastRecorded = env.recorded_at
      } catch (err) {
        skipped.push({ position: env.position, reason: (err as Error).message })
      }
    }
    foldEvents(batch, state, seen)
  }
  return { state, ids: [...seen], skipped, upcast, maxPosition: after, lastRecorded }
}

/**
 * Re-folds exactly the events the live projector has applied and diffs the
 * result against the live tables. Events still waiting in the stream are
 * reported as `notYetApplied` (lag), not as a mismatch.
 */
export async function verifyAnalytics(): Promise<ReplayResult> {
  const started = Date.now()
  const client = await pool.connect()
  try {
    // One snapshot for every read, so a concurrent live update can't show up as a false diff.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const folded = await foldLog(client, true)
    const live = await readLiveState(client)
    const { rows } = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM events')
    await client.query('COMMIT')
    const diffs = diffStates(folded.state, live)
    return {
      events: folded.ids.length,
      notYetApplied: rows[0].n - folded.ids.length - folded.skipped.length,
      skipped: folded.skipped,
      upcast: folded.upcast,
      maxPosition: folded.maxPosition,
      diffs,
      match: diffs.length === 0,
      ms: Date.now() - started,
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

export async function rebuildAnalytics(): Promise<ReplayResult> {
  const started = Date.now()
  const result = await withTransaction(async (client) => {
    await client.query('LOCK TABLE analytics_counters, analytics_latency, analytics_sources, projection_checkpoints IN EXCLUSIVE MODE')
    const folded = await foldLog(client)
    await client.query('TRUNCATE analytics_counters, analytics_latency, analytics_sources')
    await client.query('DELETE FROM processed_events WHERE consumer = $1', [PROJECTION])
    for (const [k, v] of folded.state.counters) {
      const [bucket, metric, dimension] = k.split('|')
      await client.query('INSERT INTO analytics_counters (bucket, metric, dimension, value) VALUES ($1, $2, $3, $4)', [bucket, metric, dimension, v])
    }
    for (const [k, v] of folded.state.latency) {
      const [dependency, le] = k.split('|')
      await client.query('INSERT INTO analytics_latency (dependency, le_ms, count) VALUES ($1, $2, $3)', [dependency, Number(le), v])
    }
    for (const [k, v] of folded.state.sources) {
      const [dependency, source] = k.split('|')
      await client.query('INSERT INTO analytics_sources (dependency, source, count) VALUES ($1, $2, $3)', [dependency, source, v])
    }
    for (let i = 0; i < folded.ids.length; i += 1000) {
      await client.query('INSERT INTO processed_events (consumer, event_id) SELECT $1, unnest($2::uuid[])', [PROJECTION, folded.ids.slice(i, i + 1000)])
    }
    await client.query(
      `INSERT INTO projection_checkpoints (projection, events_applied, max_position, last_recorded_at, rebuilt_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (projection) DO UPDATE SET events_applied = EXCLUDED.events_applied, max_position = EXCLUDED.max_position,
         last_recorded_at = EXCLUDED.last_recorded_at, rebuilt_at = now(), updated_at = now()`,
      [PROJECTION, folded.ids.length, folded.maxPosition, folded.lastRecorded],
    )
    return folded
  })
  const check = await verifyAnalytics()
  return {
    events: result.ids.length,
    notYetApplied: check.notYetApplied,
    skipped: result.skipped,
    upcast: result.upcast,
    maxPosition: result.maxPosition,
    diffs: check.diffs,
    match: check.match,
    ms: Date.now() - started,
  }
}
