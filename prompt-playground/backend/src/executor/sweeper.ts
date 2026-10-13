/**
 * Recovers runs that the happy path cannot. Safe to run in every executor at
 * once: each step is a conditional UPDATE, so a row is handled by exactly one.
 *
 * 1. Running runs whose lease expired (executor crashed or stalled) are failed,
 *    keeping the partial output that was already streamed. They are not
 *    retried: the user has seen part of an answer, and re-running would cost
 *    tokens and could produce a different one. The user can press Run again.
 * 2. Queued runs whose doorbell was lost (Valkey restart, enqueue error) are
 *    re-enqueued. A duplicate queue entry is harmless because claiming is
 *    conditional on status = 'queued'.
 * 3. Runs queued for too long are failed rather than left spinning.
 */
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { runsFinished } from '../shared/metrics.js'
import { appendRunEvent, decodeRunEvent, enqueueRun, runEventsKey } from '../shared/run-events.js'

const log = logger.child({ component: 'sweeper' })

/** Rebuilds the output a dead executor had already published. */
async function streamedOutput(runId: string): Promise<string> {
  const entries = (await redis.xrange(runEventsKey(runId), '-', '+')) as [string, string[]][]
  let output = ''
  for (const [, fields] of entries) {
    const event = decodeRunEvent(fields)
    if (event?.type === 'delta') output += event.text
  }
  return output
}

async function publishEnd(runId: string, model: string, errorCode: string, errorMessage: string, partial: boolean) {
  await appendRunEvent(redis, runId, {
    type: 'end',
    status: 'failed',
    outputTruncated: partial,
    finishReason: null,
    errorCode,
    errorMessage,
    usage: { inputTokens: null, outputTokens: null, queueMs: null, ttftMs: null, durationMs: null },
    at: new Date().toISOString(),
  })
  runsFinished.inc({ model, status: 'failed' })
}

export async function sweepOnce(): Promise<void> {
  const expired = await pool.query<{ id: string; model: string }>(
    `UPDATE runs
        SET status = 'failed', error_code = 'EXECUTOR_LOST', finished_at = now(),
            error_message = 'The executor running this stopped responding',
            lease_owner = NULL, lease_expires_at = NULL
      WHERE status = 'running' AND lease_expires_at < now()
      RETURNING id, model`,
  )
  for (const row of expired.rows) {
    // Close the log first, then read it: once `end` is appended no executor can add
    // output, so the stored partial output is exactly what viewers were shown.
    const seenBefore = await streamedOutput(row.id).catch(() => '')
    await publishEnd(row.id, row.model, 'EXECUTOR_LOST', 'The executor running this stopped responding', seenBefore !== '')
    const output = await streamedOutput(row.id).catch(() => seenBefore)
    if (output) {
      await pool.query('UPDATE runs SET output = $2, output_truncated = true WHERE id = $1', [row.id, output])
    }
    log.warn({ runId: row.id }, 'failed run with expired lease')
  }

  const stale = await pool.query<{ id: string; model: string }>(
    `UPDATE runs
        SET status = 'failed', error_code = 'QUEUE_TIMEOUT', finished_at = now(),
            error_message = 'No executor picked this run up in time'
      WHERE status = 'queued' AND created_at < now() - make_interval(secs => $1)
      RETURNING id, model`,
    [config.queueTimeoutSeconds],
  )
  for (const row of stale.rows) {
    await publishEnd(row.id, row.model, 'QUEUE_TIMEOUT', 'No executor picked this run up in time', false)
    log.warn({ runId: row.id }, 'failed run that waited too long in the queue')
  }

  const requeue = await pool.query<{ id: string }>(
    `UPDATE runs SET enqueued_at = now()
      WHERE status = 'queued' AND enqueued_at < now() - make_interval(secs => $1)
      RETURNING id`,
    [config.requeueAfterSeconds],
  )
  for (const row of requeue.rows) {
    await enqueueRun(redis, row.id)
    log.info({ runId: row.id }, 're-enqueued queued run')
  }
}
