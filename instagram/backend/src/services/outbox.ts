/**
 * Transactional outbox for the media pipeline.
 *
 * POST /posts inserts the post, its media rows and an outbox event in ONE transaction. This
 * relay then publishes pending events to RabbitMQ and stamps them published. The old flow
 * (commit, then publish) lost the job whenever the broker was down or the process died between
 * the two steps, leaving the post in 'processing' forever.
 *
 * Delivery is at-least-once: if we crash after the broker confirms but before our UPDATE
 * commits, the event is published again. The image worker is idempotent, so that is safe.
 * Several API instances can run the relay: FOR UPDATE SKIP LOCKED gives each one different rows.
 */
import type { PoolClient } from 'pg';
import { query, getClient } from './db.js';
import config from '../config/index.js';
import logger from './logger.js';
import { publishImageProcessingJob, isQueueReady, ensureQueueConnection, ImageProcessingJob } from './queue.js';
import { outboxPendingEvents, outboxPublishedTotal, outboxPublishFailures } from './metrics.js';

export const OUTBOX_EVENT_TYPES = {
  POST_MEDIA_UPLOADED: 'post.media_uploaded',
} as const;

export interface OutboxEvent {
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export interface RelayResult {
  published: number;
  failed: number;
  /** True when the broker was unavailable and nothing was attempted. */
  skipped: boolean;
  pending: number;
}

export interface OutboxBacklog {
  pending: number;
  oldestAgeSeconds: number | null;
}

interface OutboxRow {
  id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

/** Writes an event inside the caller's transaction. */
export async function enqueueOutboxEvent(client: PoolClient, event: OutboxEvent): Promise<void> {
  await client.query('INSERT INTO outbox_events (aggregate_id, event_type, payload) VALUES ($1, $2, $3)', [
    event.aggregateId,
    event.eventType,
    JSON.stringify(event.payload),
  ]);
}

/** Exponential backoff for an event that failed to publish: 1s, 2s, 4s ... capped at 60s. */
export const publishRetryDelayMs = (attempts: number): number =>
  Math.min(60000, 1000 * 2 ** Math.max(0, attempts - 1));

async function publishEvent(row: OutboxRow): Promise<void> {
  switch (row.event_type) {
    case OUTBOX_EVENT_TYPES.POST_MEDIA_UPLOADED:
      await publishImageProcessingJob(row.payload as ImageProcessingJob);
      return;
    default:
      throw new Error(`Unknown outbox event type: ${row.event_type}`);
  }
}

export async function getOutboxBacklog(): Promise<OutboxBacklog> {
  const result = await query<{ pending: number; oldest_age_seconds: number | null }>(
    `SELECT COUNT(*)::int AS pending,
            EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int AS oldest_age_seconds
     FROM outbox_events WHERE published_at IS NULL`
  );
  const row = result.rows[0];
  outboxPendingEvents.set(row?.pending ?? 0);
  return { pending: row?.pending ?? 0, oldestAgeSeconds: row?.oldest_age_seconds ?? null };
}

/**
 * One relay pass: claim due events, publish each with a broker confirm, record the outcome.
 * When the broker is down nothing is claimed (attempt counters only track real publish failures)
 * and a background reconnect is started instead.
 */
export async function relayOutboxOnce(): Promise<RelayResult> {
  if (!isQueueReady()) {
    ensureQueueConnection();
    const { pending } = await getOutboxBacklog();
    return { published: 0, failed: 0, skipped: true, pending };
  }

  let published = 0;
  let failed = 0;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<OutboxRow>(
      `SELECT id, event_type, payload, attempts FROM outbox_events
       WHERE published_at IS NULL AND next_attempt_at <= NOW()
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [config.mediaPipeline.relayBatchSize]
    );

    for (const row of rows) {
      try {
        await publishEvent(row);
        await client.query(
          'UPDATE outbox_events SET published_at = NOW(), attempts = attempts + 1, last_error = NULL WHERE id = $1',
          [row.id]
        );
        published += 1;
      } catch (error) {
        const err = error as Error;
        await client.query(
          `UPDATE outbox_events
           SET attempts = attempts + 1, last_error = $2,
               next_attempt_at = NOW() + ($3::int * INTERVAL '1 millisecond')
           WHERE id = $1`,
          [row.id, err.message.slice(0, 500), publishRetryDelayMs(row.attempts + 1)]
        );
        failed += 1;
        logger.warn({ outboxId: row.id, eventType: row.event_type, error: err.message }, 'Outbox publish failed');
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (published > 0) outboxPublishedTotal.inc(published);
  if (failed > 0) outboxPublishFailures.inc(failed);
  const { pending } = await getOutboxBacklog();
  return { published, failed, skipped: false, pending };
}

let relayTimer: NodeJS.Timeout | null = null;
let relayRunning: Promise<void> | null = null;
let rerunRequested = false;

async function runRelayPass(): Promise<void> {
  if (relayRunning) {
    rerunRequested = true;
    return;
  }
  relayRunning = (async () => {
    do {
      rerunRequested = false;
      try {
        const result = await relayOutboxOnce();
        if (result.published > 0 || result.failed > 0) {
          logger.info({ type: 'outbox_relay', ...result }, 'Outbox relay pass');
        }
      } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Outbox relay pass failed');
      }
    } while (rerunRequested);
  })();
  try {
    await relayRunning;
  } finally {
    relayRunning = null;
  }
}

/** Polls the outbox on an interval (idempotent: calling twice keeps one loop). */
export function startOutboxRelay(): void {
  if (relayTimer) return;
  relayTimer = setInterval(() => {
    void runRelayPass();
  }, config.mediaPipeline.relayIntervalMs);
  void runRelayPass();
}

/** Asks for an immediate pass, e.g. right after a post is created, so latency isn't the poll interval. */
export function kickOutboxRelay(): void {
  if (!relayTimer) return;
  setImmediate(() => {
    void runRelayPass();
  });
}

/** Stops polling and waits for an in-progress pass to finish. */
export async function stopOutboxRelay(): Promise<void> {
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
  if (relayRunning) await relayRunning.catch(() => undefined);
}
