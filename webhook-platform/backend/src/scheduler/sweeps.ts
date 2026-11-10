/**
 * The scheduler's passes. Each runs in its own short transaction under a
 * transaction-level advisory lock, so any number of scheduler replicas can
 * run for availability while only one does each pass at a time.
 * @module scheduler/sweeps
 */
import type pg from 'pg'
import { config } from '../shared/config.js'
import { withTransaction } from '../shared/db.js'
import { enqueue } from '../shared/dispatch.js'
import { schedulerDispatched } from '../shared/metrics.js'

const LOCK_DISPATCH = 727_101
const LOCK_LEASES = 727_102
const LOCK_STUCK = 727_103

async function locked(client: pg.PoolClient, key: number): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [key])
  return rows[0].ok
}

/**
 * Due retries → queue, fairly. For each active, unpaused endpoint, take its
 * earliest due deliveries up to its spare capacity (limit minus what is
 * already queued or in flight; 1 while it is being probed after repeated
 * failures). A dead endpoint with 50,000 due retries therefore puts at most a
 * handful of tickets in the shared queue, and the rest wait in PostgreSQL;
 * the queue never fills with work that can't run.
 */
export async function dispatchDue(): Promise<number> {
  return withTransaction(async (client) => {
    if (!(await locked(client, LOCK_DISPATCH))) return 0
    const { rows } = await client.query<{ id: string }>(
      `SELECT pick.id
         FROM endpoints e
         CROSS JOIN LATERAL (
           SELECT count(*)::int AS busy FROM deliveries x WHERE x.endpoint_id = e.id AND x.state IN ('queued', 'in_flight')
         ) l
         CROSS JOIN LATERAL (
           SELECT d.id FROM deliveries d
            WHERE d.endpoint_id = e.id AND d.state = 'scheduled' AND d.next_attempt_at <= now()
            ORDER BY d.next_attempt_at
            LIMIT GREATEST(0, (CASE WHEN e.consecutive_failures >= $1 THEN 1 ELSE e.max_concurrency END) - l.busy)
         ) pick
        WHERE e.status = 'active' AND (e.paused_until IS NULL OR e.paused_until <= now())
        LIMIT $2`,
      [config.delivery.probeAfterFailures, config.scheduler.batchSize],
    )
    const moved = await enqueue(
      client,
      rows.map((r) => r.id),
      ['scheduled'],
    )
    if (moved.length > 0) schedulerDispatched.inc({ kind: 'retry' }, moved.length)
    return moved.length
  })
}

/**
 * In-flight deliveries whose lease ran out: the worker died and its ticket
 * never came back (normally RabbitMQ redelivers it and another worker takes
 * over within seconds; this is the backstop). The attempt is recorded as
 * `lost` because nobody knows whether the receiver got it.
 */
export async function reclaimExpiredLeases(): Promise<number> {
  return withTransaction(async (client) => {
    if (!(await locked(client, LOCK_LEASES))) return 0
    const { rows } = await client.query<{ id: string; claimed_by: string | null; attempt_count: number; updated_at: Date }>(
      `SELECT id, claimed_by, attempt_count, updated_at FROM deliveries
        WHERE state = 'in_flight' AND lease_until < now() ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED`,
    )
    for (const r of rows) {
      await client.query(
        `INSERT INTO attempts (delivery_id, attempt_no, trigger, started_at, error_class, error_message, outcome, worker_id)
         VALUES ($1, $2, 'retry', $3, 'worker_lost', $4, 'lost', $5)`,
        [r.id, r.attempt_count + 1, r.updated_at, `Lease expired: worker ${r.claimed_by ?? '?'} never reported back; re-dispatching`, r.claimed_by],
      )
      await client.query('UPDATE deliveries SET attempt_count = attempt_count + 1 WHERE id = $1', [r.id])
    }
    const moved = await enqueue(
      client,
      rows.map((r) => r.id),
      ['in_flight'],
    )
    if (moved.length > 0) schedulerDispatched.inc({ kind: 'lease_reclaimed' }, moved.length)
    return moved.length
  })
}

/**
 * Deliveries queued long ago and never claimed: their ticket was lost in the
 * broker. Re-dispatching bumps dispatch_seq, so if the old ticket does turn
 * up it is stale and dropped. PostgreSQL, not the queue, decides what is owed.
 */
export async function requeueStuck(): Promise<number> {
  return withTransaction(async (client) => {
    if (!(await locked(client, LOCK_STUCK))) return 0
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM deliveries WHERE state = 'queued' AND queued_at < now() - make_interval(secs => $1)
        ORDER BY queued_at LIMIT 200 FOR UPDATE SKIP LOCKED`,
      [config.scheduler.stuckQueuedSeconds],
    )
    const moved = await enqueue(
      client,
      rows.map((r) => r.id),
      ['queued'],
    )
    if (moved.length > 0) schedulerDispatched.inc({ kind: 'stuck_requeued' }, moved.length)
    return moved.length
  })
}

export async function pruneOutbox(): Promise<number> {
  return withTransaction(async (client) => {
    const r = await client.query(
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox WHERE published_at IS NOT NULL AND published_at < now() - make_interval(secs => $1) LIMIT 5000)`,
      [config.scheduler.outboxRetentionSeconds],
    )
    return r.rowCount ?? 0
  })
}
