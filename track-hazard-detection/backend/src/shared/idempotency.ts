/**
 * Idempotent consumers. Each consumer group records the event ids it has
 * applied in `processed_events`, inside the same transaction as its effects.
 * A redelivered event finds its row and becomes a no-op.
 * @module shared/idempotency
 */
import type { Queryable } from './db.js'

/** Returns true the first time (consumer, eventId) is seen in this transaction's view; false for a duplicate. */
export async function markProcessed(db: Queryable, consumer: string, eventId: string): Promise<boolean> {
  const { rowCount } = await db.query('INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [consumer, eventId])
  return (rowCount ?? 0) > 0
}
