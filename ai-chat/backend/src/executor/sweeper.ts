/**
 * Recovers generations that the happy path cannot. Safe to run in every
 * executor at once: each step is a conditional UPDATE, so a row is handled by
 * exactly one.
 *
 * 1. Running generations whose lease expired (executor crashed or stalled) are
 *    failed, keeping the partial output that was already streamed. They are
 *    not retried: the user has seen part of an answer, and re-running would
 *    cost tokens and produce a different one. The user can press Regenerate.
 * 2. Accepted generations whose doorbell was lost (Valkey restart, enqueue
 *    error) are re-enqueued. A duplicate queue entry is harmless because
 *    claiming is conditional on status = 'accepted'.
 * 3. Generations accepted too long ago are failed rather than left spinning.
 */
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import {
  appendGenerationEvent,
  decodeGenerationEvent,
  emptyUsage,
  enqueueGeneration,
  generationEventsKey,
} from '../shared/generation-events.js'
import { logger } from '../shared/logger.js'
import { generationsFinished } from '../shared/metrics.js'
import { publishUserEvent } from '../shared/user-events.js'

const log = logger.child({ component: 'sweeper' })

interface SweptRow {
  id: string
  model: string
  user_id: string
  conversation_id: string
  assistant_message_id: string
  output: string
}

/** Rebuilds the output a dead executor had already published. */
async function streamedOutput(generationId: string): Promise<string> {
  const entries = (await redis.xrange(generationEventsKey(generationId), '-', '+')) as [string, string[]][]
  let output = ''
  for (const [, fields] of entries) {
    const event = decodeGenerationEvent(fields)
    if (event?.type === 'delta') output += event.text
  }
  return output
}

async function publishFailure(row: SweptRow, errorCode: string, errorMessage: string, partial: boolean) {
  await appendGenerationEvent(redis, row.id, {
    type: 'end',
    status: 'failed',
    outputTruncated: partial,
    finishReason: null,
    errorCode,
    errorMessage,
    usage: emptyUsage(),
    at: new Date().toISOString(),
  })
  await publishUserEvent(redis, row.user_id, {
    type: 'generation.finished',
    conversationId: row.conversation_id,
    generationId: row.id,
    assistantMessageId: row.assistant_message_id,
    status: 'failed',
  })
  generationsFinished.inc({ model: row.model, status: 'failed' })
}

export async function sweepOnce(): Promise<void> {
  const expired = await pool.query<SweptRow>(
    `UPDATE generations
        SET status = 'failed', error_code = 'EXECUTOR_LOST', finished_at = now(),
            error_message = 'The server writing this answer stopped responding',
            lease_owner = NULL, lease_expires_at = NULL
      WHERE status = 'running' AND lease_expires_at < now()
      RETURNING id, model, user_id, conversation_id, assistant_message_id, output`,
  )
  for (const row of expired.rows) {
    // Close the log first, then read it: once `end` is appended no executor can add
    // output, so the stored partial output is exactly what viewers were shown.
    const before = await streamedOutput(row.id).catch(() => '')
    await publishFailure(row, 'EXECUTOR_LOST', 'The server writing this answer stopped responding', before !== '')
    const streamed = await streamedOutput(row.id).catch(() => before)
    // If Valkey lost the stream too, the last PostgreSQL checkpoint is the best we have.
    const output = streamed.length >= row.output.length ? streamed : row.output
    await pool.query(
      `UPDATE generations SET output = $2, output_truncated = $2 <> '' WHERE id = $1`,
      [row.id, output],
    )
    await pool.query('UPDATE messages SET content = $2 WHERE id = $1', [row.assistant_message_id, output])
    log.warn({ generationId: row.id }, 'failed generation with expired lease')
  }

  const stale = await pool.query<SweptRow>(
    `UPDATE generations
        SET status = 'failed', error_code = 'QUEUE_TIMEOUT', finished_at = now(),
            error_message = 'No server picked this request up in time'
      WHERE status = 'accepted' AND created_at < now() - make_interval(secs => $1)
      RETURNING id, model, user_id, conversation_id, assistant_message_id, output`,
    [config.queueTimeoutSeconds],
  )
  for (const row of stale.rows) {
    await publishFailure(row, 'QUEUE_TIMEOUT', 'No server picked this request up in time', false)
    log.warn({ generationId: row.id }, 'failed generation that waited too long in the queue')
  }

  const requeue = await pool.query<{ id: string }>(
    `UPDATE generations SET enqueued_at = now()
      WHERE status = 'accepted' AND enqueued_at < now() - make_interval(secs => $1)
      RETURNING id`,
    [config.requeueAfterSeconds],
  )
  for (const row of requeue.rows) {
    await enqueueGeneration(redis, row.id)
    log.info({ generationId: row.id }, 're-enqueued accepted generation')
  }
}
