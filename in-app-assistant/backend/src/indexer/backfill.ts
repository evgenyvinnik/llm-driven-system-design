/**
 * Backfill: when the feature is first turned on, every existing message and
 * document goes through the pipeline once, in the lowest-priority lane so it
 * never delays live changes.
 */
import { pool } from '../shared/db.js'
import { PRIORITY } from '../shared/outbox.js'

export async function enqueueBackfill(): Promise<number> {
  const { rowCount: mail } = await pool.query(
    `INSERT INTO index_events (source_type, source_id, op, priority) SELECT 'mail', id, 'upsert', $1 FROM mail_messages`,
    [PRIORITY.backfill],
  )
  const { rowCount: docs } = await pool.query(
    `INSERT INTO index_events (source_type, source_id, op, priority) SELECT 'doc', id, 'upsert', $1 FROM documents`,
    [PRIORITY.backfill],
  )
  return (mail ?? 0) + (docs ?? 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = await enqueueBackfill()
  console.log(`Enqueued ${count} backfill events; the indexer will process them`)
  await pool.end()
}
