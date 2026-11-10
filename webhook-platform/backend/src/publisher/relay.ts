/**
 * Outbox relay: PostgreSQL → RabbitMQ.
 *
 * Claims a batch of unpublished outbox rows (`FOR UPDATE SKIP LOCKED`, so
 * several publishers can run side by side without taking the same rows),
 * publishes one ticket per row on a confirm channel, waits for the broker's
 * confirms, then marks the rows published and commits.
 *
 * If the publisher dies after publishing but before the commit, the rows
 * stay unpublished and are published again by the next pass: RabbitMQ then
 * holds two tickets for the same dispatch. That is fine, because workers
 * claim deliveries with a conditional update and the second ticket finds
 * nothing to claim. The outbox gives at-least-once publishing; correctness
 * comes from the idempotent consumer, not from the relay.
 *
 * Rows are marked one by one (`published_at`), never by a "last published
 * id" checkpoint: ids from concurrent transactions commit out of order, and
 * a checkpoint would skip a row that committed late.
 * @module publisher/relay
 */
import type { ConfirmChannel } from 'amqplib'
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import { outboxPublished } from '../shared/metrics.js'
import { encodeTicket } from '../shared/queue.js'
import { logger } from '../shared/logger.js'

export async function publishBatch(ch: ConfirmChannel): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; delivery_id: string; dispatch_seq: number }>(
      `SELECT id, delivery_id, dispatch_seq FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [config.publisher.batchSize],
    )
    if (rows.length === 0) return 0
    for (const r of rows) {
      const ok = ch.publish(config.queue.exchange, config.queue.deliveries, encodeTicket({ deliveryId: r.delivery_id, dispatchSeq: r.dispatch_seq }), {
        persistent: true,
        contentType: 'application/json',
        messageId: `${r.delivery_id}:${r.dispatch_seq}`,
      })
      if (!ok) await new Promise<void>((resolve) => ch.once('drain', () => resolve()))
    }
    // Throws if the broker nacks any message; the transaction rolls back and the rows are retried.
    const confirmStart = Date.now()
    await ch.waitForConfirms()
    const confirmMs = Date.now() - confirmStart
    if (confirmMs > 1000) logger.warn({ confirmMs, rows: rows.length }, 'slow broker confirm')
    await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)])
    outboxPublished.inc(rows.length)
    return rows.length
  })
}
