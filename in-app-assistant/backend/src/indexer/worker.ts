/**
 * Outbox consumer. Claims a batch of index events with SKIP LOCKED (so several
 * indexer processes can share the work), coalesces events per source, runs
 * the pipeline, and marks the events processed in the same transaction as
 * the chunk writes.
 *
 * Priority lanes: permission changes and deletes (0) are processed first and
 * immediately. Content changes (1) wait INDEX_CONTENT_DELAY_MS, standing in
 * for the real pipeline's parse/embed latency, which is why search also reads
 * not-yet-indexed mail directly from the mailbox. Backfill (2) runs last.
 * @module indexer/worker
 */
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import { childLogger } from '../shared/logger.js'
import { deleteSource, indexDoc, indexMail, updateAcl } from './pipeline.js'

const log = childLogger('indexer')
const MAX_ATTEMPTS = 5

interface EventRow {
  id: string
  source_type: 'mail' | 'doc'
  source_id: string
  op: 'upsert' | 'delete' | 'acl'
  priority: number
}

export interface BatchOutcome {
  events: number
  sources: number
  chunks: number
}

export async function processBatch(): Promise<BatchOutcome> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<EventRow>(
      `SELECT id, source_type, source_id, op, priority FROM index_events
        WHERE processed_at IS NULL
          AND (priority <> 1 OR enqueued_at < now() - make_interval(secs => $1::double precision / 1000))
        ORDER BY priority, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [config.index.contentDelayMs, config.index.batchSize],
    )
    if (rows.length === 0) return { events: 0, sources: 0, chunks: 0 }

    // Coalesce: one pass per source. A delete wins; an upsert recomputes the
    // ACL as well, so it subsumes an ACL-only event.
    const plan = new Map<string, { type: 'mail' | 'doc'; id: string; op: EventRow['op'] }>()
    for (const row of rows) {
      const key = `${row.source_type}:${row.source_id}`
      const current = plan.get(key)
      const rank = { delete: 3, upsert: 2, acl: 1 }
      if (!current || rank[row.op] > rank[current.op]) plan.set(key, { type: row.source_type, id: row.source_id, op: row.op })
    }

    let chunks = 0
    for (const item of plan.values()) {
      await client.query('SAVEPOINT source')
      try {
        if (item.op === 'delete') chunks += await deleteSource(client, item.type, item.id)
        else if (item.op === 'acl') chunks += await updateAcl(client, item.type, item.id)
        else if (item.type === 'mail') chunks += await indexMail(client, item.id)
        else chunks += await indexDoc(client, item.id)
        await client.query('RELEASE SAVEPOINT source')
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT source')
        const ids = rows.filter((r) => r.source_type === item.type && r.source_id === item.id).map((r) => r.id)
        log.error({ err, source: item }, 'indexing failed')
        await client.query(
          `UPDATE index_events SET attempts = attempts + 1, last_error = $2,
                  processed_at = CASE WHEN attempts + 1 >= $3 THEN now() END
            WHERE id = ANY($1::bigint[])`,
          [ids, (err as Error).message.slice(0, 500), MAX_ATTEMPTS],
        )
        rows.splice(0, rows.length, ...rows.filter((r) => !ids.includes(r.id)))
      }
    }
    await client.query('UPDATE index_events SET processed_at = now(), attempts = attempts + 1 WHERE id = ANY($1::bigint[])', [
      rows.map((r) => r.id),
    ])
    return { events: rows.length, sources: plan.size, chunks }
  })
}

/** Drains everything currently eligible. Used by the seed script and tests. */
export async function drain(): Promise<BatchOutcome> {
  const total = { events: 0, sources: 0, chunks: 0 }
  while (true) {
    const outcome = await processBatch()
    if (outcome.events === 0) return total
    total.events += outcome.events
    total.sources += outcome.sources
    total.chunks += outcome.chunks
  }
}

export interface IndexStatus {
  pending: { lane: string; count: number; oldestSeconds: number | null }[]
  chunks: { sourceType: string; count: number }[]
  lastIndexedAt: string | null
  failed: number
}

export async function indexStatus(): Promise<IndexStatus> {
  const [pending, chunks, last, failed] = await Promise.all([
    pool.query<{ priority: number; count: string; oldest: number | null }>(
      `SELECT priority, count(*) AS count, EXTRACT(EPOCH FROM now() - min(enqueued_at))::float AS oldest
         FROM index_events WHERE processed_at IS NULL GROUP BY priority ORDER BY priority`,
    ),
    pool.query<{ source_type: string; count: string }>('SELECT source_type, count(*) AS count FROM chunks GROUP BY source_type'),
    pool.query<{ at: Date | null }>('SELECT max(indexed_at) AS at FROM chunks'),
    pool.query<{ count: string }>("SELECT count(*) AS count FROM index_events WHERE last_error IS NOT NULL AND processed_at IS NOT NULL"),
  ])
  const lanes = ['permissions & deletes', 'content', 'backfill']
  return {
    pending: lanes.map((lane, priority) => {
      const row = pending.rows.find((r) => Number(r.priority) === priority)
      return { lane, count: row ? Number(row.count) : 0, oldestSeconds: row?.oldest ?? null }
    }),
    chunks: chunks.rows.map((r) => ({ sourceType: r.source_type, count: Number(r.count) })),
    lastIndexedAt: last.rows[0]?.at?.toISOString() ?? null,
    failed: Number(failed.rows[0]?.count ?? 0),
  }
}
