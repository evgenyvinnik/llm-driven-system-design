import type { PoolClient } from 'pg';
import { pool, query } from '../utils/database.js';
import { getQueueName, QueueMessage } from '../utils/rabbitmq.js';
import { createLogger } from '../utils/logger.js';
import { outboxPublishedCounter } from '../utils/metrics.js';
import { Logger } from 'pino';

const log: Logger = createLogger('outbox');

/** The relay drains critical rows before high, normal and low. */
export const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface OutboxEntry {
  notificationId: string;
  userId: string;
  channel: string;
  priority: string;
  availableAt: Date;
}

/** Anything that can publish one message and resolve only once the broker confirmed it. */
export interface OutboxPublisher {
  publish(queueName: string, message: QueueMessage): Promise<void>;
}

export interface RelayResult {
  published: number;
  failed: number;
}

/**
 * Writes one outbox row per delivery, on the caller's transaction. Nothing is
 * published here: if the transaction rolls back, no message ever existed.
 */
export async function enqueueDeliveries(client: PoolClient, entries: OutboxEntry[]): Promise<void> {
  for (const entry of entries) {
    const payload: QueueMessage = {
      notificationId: entry.notificationId,
      userId: entry.userId,
      channel: entry.channel,
      priority: entry.priority,
      queuedAt: entry.availableAt.getTime(),
    };
    await client.query(
      `INSERT INTO delivery_outbox
         (notification_id, channel, priority, priority_rank, payload, available_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.notificationId,
        entry.channel,
        entry.priority,
        PRIORITY_RANK[entry.priority] ?? PRIORITY_RANK.normal,
        JSON.stringify(payload),
        entry.availableAt,
      ]
    );
  }
}

interface OutboxRow {
  id: string;
  channel: string;
  priority: string;
  payload: QueueMessage;
}

/**
 * Publishes up to `limit` due rows, most urgent first. The rows stay locked
 * (FOR UPDATE SKIP LOCKED) until the batch commits, so several relays can run
 * side by side without publishing the same row twice; a relay that crashes
 * mid-batch rolls back, and those rows are published again later. That replay
 * is why consumers must be idempotent.
 */
export async function relayOutboxBatch(publisher: OutboxPublisher, limit: number = 100): Promise<RelayResult> {
  const client = await pool.connect();
  let published = 0;
  let failed = 0;

  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, channel, priority, payload
       FROM delivery_outbox
       WHERE published_at IS NULL AND available_at <= NOW()
       ORDER BY priority_rank, available_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );

    const publishedIds: string[] = [];
    for (const row of rows) {
      try {
        await publisher.publish(getQueueName(row.channel, row.priority), row.payload);
        publishedIds.push(row.id);
        outboxPublishedCounter.labels(row.channel, row.priority).inc();
      } catch (error) {
        failed++;
        await client.query(
          `UPDATE delivery_outbox
           SET publish_attempts = publish_attempts + 1, last_error = $2
           WHERE id = $1`,
          [row.id, (error as Error).message.slice(0, 500)]
        );
        // The broker is most likely unavailable; stop and let the next pass retry.
        log.warn({ outboxId: row.id, err: error }, 'Outbox publish failed; stopping batch');
        break;
      }
    }

    if (publishedIds.length > 0) {
      await client.query(
        `UPDATE delivery_outbox SET published_at = NOW() WHERE id = ANY($1::bigint[])`,
        [publishedIds]
      );
    }
    published = publishedIds.length;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { published, failed };
}

/** Deletes published rows older than `retainHours`; they only exist for debugging. */
export async function purgePublishedOutbox(retainHours: number = 24): Promise<number> {
  const result = await query(
    `DELETE FROM delivery_outbox
     WHERE published_at IS NOT NULL AND published_at < NOW() - make_interval(hours => $1)`,
    [retainHours]
  );
  return result.rowCount ?? 0;
}

/** Seconds the oldest due-but-unpublished row has been waiting (0 when caught up). */
export async function getOutboxLagSeconds(): Promise<number> {
  const result = await query<{ lag: string | null }>(
    `SELECT EXTRACT(EPOCH FROM NOW() - MIN(available_at)) AS lag
     FROM delivery_outbox
     WHERE published_at IS NULL AND available_at <= NOW()`
  );
  const lag = Number(result.rows[0]?.lag ?? 0);
  return Number.isFinite(lag) ? Math.max(0, Math.round(lag)) : 0;
}

export interface RelayLoopOptions {
  batchSize?: number;
  idleDelayMs?: number;
  errorDelayMs?: number;
}

/**
 * Runs the relay until `stop()` is called: back-to-back while batches come back
 * full, every `idleDelayMs` when caught up, slower after errors.
 */
export function startOutboxRelay(publisher: OutboxPublisher, options: RelayLoopOptions = {}): { stop: () => Promise<void> } {
  const batchSize = options.batchSize ?? 100;
  const idleDelayMs = options.idleDelayMs ?? 200;
  const errorDelayMs = options.errorDelayMs ?? 2000;
  let running = true;
  let wake: (() => void) | null = null;
  let lastPurge = 0;

  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  const loop = (async () => {
    while (running) {
      let delay = idleDelayMs;
      try {
        const { published, failed } = await relayOutboxBatch(publisher, batchSize);
        if (failed > 0) delay = errorDelayMs;
        else if (published === batchSize) delay = 0;

        if (Date.now() - lastPurge > 10 * 60 * 1000) {
          lastPurge = Date.now();
          await purgePublishedOutbox();
        }
      } catch (error) {
        log.error({ err: error }, 'Outbox relay pass failed');
        delay = errorDelayMs;
      }
      if (running && delay > 0) await pause(delay);
    }
  })();

  return {
    stop: async () => {
      running = false;
      wake?.();
      await loop;
    },
  };
}
