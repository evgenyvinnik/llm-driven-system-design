/**
 * Transactional outbox for the retrieval index. Host-app writes call this with
 * the same transaction client, so the change and its index event commit
 * together or not at all.
 * @module shared/outbox
 */
import type { Queryable } from './db.js'

export type IndexOp = 'upsert' | 'delete' | 'acl'

/** Permission changes and deletes jump the queue; content waits its turn. */
export const PRIORITY = { acl: 0, delete: 0, upsert: 1, backfill: 2 } as const

export async function enqueueIndexEvent(
  db: Queryable,
  sourceType: 'mail' | 'doc',
  sourceId: string,
  op: IndexOp,
  priority: number = PRIORITY[op],
): Promise<void> {
  await db.query('INSERT INTO index_events (source_type, source_id, op, priority) VALUES ($1, $2, $3, $4)', [
    sourceType,
    sourceId,
    op,
    priority,
  ])
}
