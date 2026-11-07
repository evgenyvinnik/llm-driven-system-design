/**
 * The sweeper runs inside every worker; `FOR UPDATE SKIP LOCKED` lets several
 * run at once without doing the same row twice. Each tick it:
 *
 * 1. reclaims running jobs whose lease expired (the worker died or froze):
 *    back to pending, or poisoned when attempts are used up;
 * 2. publishes tickets for pending jobs that are due and were never
 *    dispatched (or whose ticket was lost long enough ago);
 * 3. fails answer runs whose executing API instance stopped heartbeating,
 *    keeping the partial output, and tells any open stream.
 *
 * Every comparison is against the database clock.
 * @module worker/sweeper
 */
import { config } from '../shared/config.js'
import { keys, redis } from '../shared/cache.js'
import { pool, withTransaction } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import type { TicketPublisher } from '../shared/queue.js'
import { onPoisonFor } from './run-ticket.js'

interface ExpiredRow {
  id: string
  status: string
  stage: string
  document_id: string
  version_id: string | null
  attempts: number
  old_token: string | null
  old_owner: string | null
}

async function reclaimExpired(): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<ExpiredRow>(
      `WITH expired AS (
         SELECT id, lease_token, lease_owner FROM processing_jobs
          WHERE status = 'running' AND lease_expires_at < now()
          ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 100
       )
       UPDATE processing_jobs j SET
         status = CASE WHEN j.attempts >= j.max_attempts THEN 'poisoned' ELSE 'pending' END,
         next_run_at = now(), dispatched_at = NULL,
         finished_at = CASE WHEN j.attempts >= j.max_attempts THEN now() ELSE NULL END,
         last_error = 'worker lease expired (worker presumed dead)',
         lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       FROM expired e WHERE j.id = e.id
       RETURNING j.id, j.status, j.stage, j.document_id, j.version_id, j.attempts, e.lease_token AS old_token, e.lease_owner AS old_owner`,
    )
    for (const r of rows) {
      await client.query(`UPDATE job_attempts SET outcome = 'lost', finished_at = now(), error = $3 WHERE job_id = $1 AND lease_token = $2 AND outcome IS NULL`, [
        r.id,
        r.old_token,
        `lease expired; worker ${r.old_owner ?? '?'} presumed dead`,
      ])
      if (r.status === 'poisoned') await onPoisonFor(r, 'worker lease expired on every attempt', false)(client)
    }
    if (rows.length > 0) logger.warn({ jobs: rows.map((r) => `${r.stage}:${r.id}`) }, 'reclaimed jobs with expired leases')
    return rows.length
  })
}

async function dispatchDue(publisher: TicketPublisher): Promise<number> {
  if (!publisher.connected()) return 0
  const { rows } = await pool.query<{ id: string }>(
    `WITH due AS (
       SELECT id FROM processing_jobs
        WHERE status = 'pending' AND next_run_at <= now()
          AND (dispatched_at IS NULL OR dispatched_at < now() - ($1 || ' milliseconds')::interval)
        ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 200
     )
     UPDATE processing_jobs j SET dispatched_at = now() FROM due WHERE j.id = due.id RETURNING j.id`,
    [String(config.pipeline.redispatchAfterMs)],
  )
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return 0
  if (!(await publisher.publish(ids))) {
    await pool.query(`UPDATE processing_jobs SET dispatched_at = NULL WHERE id = ANY($1) AND status = 'pending'`, [ids])
    return 0
  }
  return ids.length
}

async function failStaleRuns(): Promise<number> {
  const { rows } = await pool.query<{ id: string; output_text: string }>(
    `UPDATE answer_runs SET status = 'failed', error = 'The API instance running this answer stopped responding; partial output kept',
       finished_at = now()
     WHERE id IN (
       SELECT id FROM answer_runs
        WHERE (status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval)
           OR (status = 'queued' AND created_at < now() - ($1 || ' milliseconds')::interval)
        FOR UPDATE SKIP LOCKED LIMIT 50)
     RETURNING id, output_text`,
    [String(config.answers.runLeaseMs)],
  )
  for (const r of rows) {
    await redis
      .xadd(keys.runEvents(r.id), '*', 'type', 'failed', 'data', JSON.stringify({ error: 'executor lost', outputText: r.output_text }))
      .then(() => redis.expire(keys.runEvents(r.id), config.answers.streamTtlSeconds))
      .catch(() => undefined)
  }
  return rows.length
}

export function startSweeper(publisher: TicketPublisher): () => void {
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      await reclaimExpired()
      await dispatchDue(publisher)
      await failStaleRuns()
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'sweep failed')
    } finally {
      if (!stopped) setTimeout(() => void tick(), config.pipeline.sweepMs)
    }
  }
  setTimeout(() => void tick(), config.pipeline.sweepMs)
  return () => {
    stopped = true
  }
}
