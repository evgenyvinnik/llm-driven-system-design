/**
 * Executes one generation: claim → build context → stream from the model →
 * publish deltas → checkpoint → finalize.
 *
 * Ownership is decided in PostgreSQL, not by the queue. The claim is a
 * conditional UPDATE (status 'accepted' → 'running') that also increments
 * `attempt` and sets a lease. Every later write (checkpoints, the outcome) is
 * conditioned on that attempt still owning a running row, so an executor that
 * stalled past its lease, and was failed by the sweeper, cannot overwrite the
 * outcome.
 *
 * Live output goes to the generation's Valkey stream every 50 ms. Every
 * CHECKPOINT_INTERVAL_MS the output published so far is written to
 * PostgreSQL together with the stream entry ID it covers, so a client that
 * loads the checkpoint can resume the stream exactly after it.
 */
import { redis } from '../shared/cache.js'
import { config } from '../shared/config.js'
import { buildContext, type ContextMessage } from '../shared/context.js'
import { findModel } from '../shared/catalog.js'
import { pool } from '../shared/db.js'
import { appendGenerationEvent, type TerminalStatus } from '../shared/generation-events.js'
import { logger } from '../shared/logger.js'
import {
  checkpointsWritten,
  generationQueueSeconds,
  generationsFinished,
  generationTtftSeconds,
} from '../shared/metrics.js'
import { publishUserEvent } from '../shared/user-events.js'
import { ModelRequestError, RetryableModelError, streamModel, type ModelEvent } from './model-client.js'

export type AbortReason = 'cancelled' | 'lease_lost' | 'shutdown' | 'timeout'

export interface InFlightGeneration {
  controller: AbortController
  reason?: AbortReason
}

export function abortGeneration(entry: InFlightGeneration, reason: AbortReason): void {
  if (entry.reason) return
  entry.reason = reason
  entry.controller.abort()
}

const FLUSH_INTERVAL_MS = 50
const MAX_START_ATTEMPTS = 3
const IDLE_TIMEOUT_MS = 30_000

interface ClaimedGeneration {
  attempt: number
  model: string
  conversation_id: string
  user_id: string
  user_message_id: string
  assistant_message_id: string
  created_at: Date
  started_at: Date
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The path from the root to the user message being answered, oldest first.
 * The walk stops once it has collected about twice the token budget, so a
 * 5,000-message conversation does not read 5,000 rows to build a 3,000-token prompt.
 */
async function loadPath(userMessageId: string, budgetTokens: number): Promise<{ path: ContextMessage[]; oldestDepth: number }> {
  const { rows } = await pool.query<{ role: 'user' | 'assistant'; content: string; depth: number }>(
    `WITH RECURSIVE path AS (
       SELECT id, parent_id, role, content, depth, length(content) / 4 AS tokens
         FROM messages WHERE id = $1
       UNION ALL
       SELECT m.id, m.parent_id, m.role, m.content, m.depth, p.tokens + length(m.content) / 4
         FROM messages m JOIN path p ON m.id = p.parent_id
        WHERE p.tokens < $2
     )
     SELECT role, content, depth FROM path ORDER BY depth`,
    [userMessageId, budgetTokens * 2],
  )
  return { path: rows.map((r) => ({ role: r.role, content: r.content })), oldestDepth: rows[0]?.depth ?? 0 }
}

export async function executeGeneration(
  generationId: string,
  executorId: string,
  inFlight: Map<string, InFlightGeneration>,
): Promise<void> {
  const claim = await pool.query<ClaimedGeneration>(
    `UPDATE generations
        SET status = 'running', attempt = attempt + 1, lease_owner = $2,
            lease_expires_at = now() + make_interval(secs => $3), started_at = now()
      WHERE id = $1 AND status = 'accepted'
      RETURNING attempt, model, conversation_id, user_id, user_message_id, assistant_message_id, created_at, started_at`,
    [generationId, executorId, config.leaseSeconds],
  )
  // Already claimed, cancelled while accepted, or finished: the queue entry was a duplicate.
  if (claim.rows.length === 0) return

  const gen = claim.rows[0]
  const { attempt } = gen
  const log = logger.child({ generationId, attempt })
  const entry: InFlightGeneration = { controller: new AbortController() }
  inFlight.set(generationId, entry)
  generationQueueSeconds.observe((gen.started_at.getTime() - gen.created_at.getTime()) / 1000)

  const spec = findModel(gen.model)
  // The model's context window, capped by the deployment-wide budget.
  const budget = Math.min(spec?.contextTokens ?? config.contextBudgetTokens, config.contextBudgetTokens)

  let output = ''
  let outputTokens = 0
  // What has been appended to the Valkey stream, and the entry ID of the last delta.
  // A checkpoint always pairs these two, so checkpoint text + events after the ID = the full output.
  let published = ''
  let lastEventId: string | null = null
  let pending = ''
  let publishChain: Promise<unknown> = Promise.resolve()
  const flush = () => {
    if (!pending) return publishChain
    const text = pending
    pending = ''
    publishChain = publishChain.then(async () => {
      const id = await appendGenerationEvent(redis, generationId, { type: 'delta', text })
      if (id) {
        published += text
        lastEventId = id
      }
    })
    return publishChain
  }
  const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)

  let checkpointedLength = 0
  let checkpointing = false
  const checkpoint = async () => {
    if (checkpointing || published.length === checkpointedLength || !lastEventId) return
    checkpointing = true
    const text = published
    const eventId = lastEventId
    try {
      await pool.query(
        `UPDATE generations
            SET output = $3, checkpoint_event_id = $4, checkpointed_at = now(), output_tokens = $5
          WHERE id = $1 AND attempt = $2 AND status = 'running'`,
        [generationId, attempt, text, eventId, outputTokens],
      )
      checkpointedLength = text.length
      checkpointsWritten.inc()
    } catch (err) {
      log.warn({ err }, 'checkpoint failed; the live stream still has the output')
    } finally {
      checkpointing = false
    }
  }
  const checkpointTimer = setInterval(() => void checkpoint(), config.checkpointIntervalMs)

  let lastTokenAt = Date.now()
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const { rows } = await pool.query<{ cancel_requested_at: Date | null }>(
          `UPDATE generations SET lease_expires_at = now() + make_interval(secs => $4)
            WHERE id = $1 AND attempt = $2 AND status = 'running' AND lease_owner = $3
            RETURNING cancel_requested_at`,
          [generationId, attempt, executorId, config.leaseSeconds],
        )
        if (rows.length === 0) abortGeneration(entry, 'lease_lost')
        else if (rows[0].cancel_requested_at) abortGeneration(entry, 'cancelled') // covers a missed pub/sub message
        if (Date.now() - lastTokenAt > IDLE_TIMEOUT_MS) abortGeneration(entry, 'timeout')
      } catch (err) {
        log.warn({ err }, 'heartbeat failed')
      }
    })()
  }, config.heartbeatMs)

  let inputTokens: number | null = null

  async function finalize(
    status: TerminalStatus,
    fields: { finishReason?: string; errorCode?: string; errorMessage?: string; inputTokens?: number },
  ): Promise<void> {
    // PostgreSQL is the record of the outcome; a Valkey hiccup must not stop it being written.
    await flush().catch((err) => log.warn({ err }, 'could not publish final output delta'))
    const truncated = status !== 'completed' && output.length > 0
    const client = await pool.connect()
    let row: { created_at: Date; started_at: Date; first_token_at: Date | null; finished_at: Date } | undefined
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `UPDATE generations
            SET status = $3, output = $4, output_truncated = $5, finish_reason = $6, error_code = $7,
                error_message = $8, input_tokens = $9, output_tokens = $10, checkpoint_event_id = $11,
                checkpointed_at = now(), finished_at = now(), lease_owner = NULL, lease_expires_at = NULL
          WHERE id = $1 AND attempt = $2 AND status = 'running'
          RETURNING created_at, started_at, first_token_at, finished_at`,
        [
          generationId,
          attempt,
          status,
          output,
          truncated,
          fields.finishReason ?? null,
          fields.errorCode ?? null,
          fields.errorMessage ?? null,
          fields.inputTokens ?? inputTokens,
          outputTokens,
          lastEventId,
        ],
      )
      row = rows[0]
      if (row) {
        // The assistant message gets its content once, when the attempt ends.
        await client.query('UPDATE messages SET content = $2 WHERE id = $1', [gen.assistant_message_id, output])
        await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [gen.conversation_id])
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    } finally {
      client.release()
    }
    if (!row) {
      log.warn({ status }, 'generation no longer owned by this attempt; outcome discarded')
      return
    }
    const span = (a: Date | null, b: Date | null) => (a && b ? b.getTime() - a.getTime() : null)
    // Appended after the commit, so a client that sees `end` and re-reads gets the final row.
    await appendGenerationEvent(redis, generationId, {
      type: 'end',
      status,
      outputTruncated: truncated,
      finishReason: fields.finishReason ?? null,
      errorCode: fields.errorCode ?? null,
      errorMessage: fields.errorMessage ?? null,
      usage: {
        inputTokens: fields.inputTokens ?? inputTokens,
        outputTokens,
        queueMs: span(row.created_at, row.started_at),
        ttftMs: span(row.started_at, row.first_token_at),
        durationMs: span(row.started_at, row.finished_at),
      },
      at: row.finished_at.toISOString(),
    }).catch((err) => log.warn({ err }, 'could not publish end event; readers fall back to PostgreSQL'))
    await publishUserEvent(redis, gen.user_id, {
      type: 'generation.finished',
      conversationId: gen.conversation_id,
      generationId,
      assistantMessageId: gen.assistant_message_id,
      status,
    })
    generationsFinished.inc({ model: gen.model, status })
    log.info({ status, outputTokens, errorCode: fields.errorCode }, 'generation finished')
  }

  try {
    await appendGenerationEvent(redis, generationId, {
      type: 'status',
      status: 'running',
      attempt,
      at: gen.started_at.toISOString(),
    })
    // A cancel that raced the claim may have been published before we subscribed to it.
    const { rows: cancelCheck } = await pool.query('SELECT cancel_requested_at FROM generations WHERE id = $1', [
      generationId,
    ])
    if (cancelCheck[0]?.cancel_requested_at) abortGeneration(entry, 'cancelled')

    const { path, oldestDepth } = await loadPath(gen.user_message_id, budget)
    const context = buildContext(path, budget)
    inputTokens = context.inputTokens
    await pool.query(
      `UPDATE generations SET context_messages = $3, context_dropped = $4, input_tokens = $5
        WHERE id = $1 AND attempt = $2 AND status = 'running'`,
      [generationId, attempt, context.messages.length, oldestDepth + context.dropped, context.inputTokens],
    )

    let outcome: ModelEvent | null = null
    for (let startAttempt = 1; !outcome && !entry.reason; startAttempt++) {
      try {
        for await (const event of streamModel(
          {
            model: gen.model,
            messages: context.messages,
            maxTokens: spec?.maxOutputTokens ?? 600,
            nonce: generationId,
          },
          entry.controller.signal,
        )) {
          if (event.type === 'token') {
            if (outputTokens === 0) {
              await pool.query(
                `UPDATE generations SET first_token_at = now() WHERE id = $1 AND attempt = $2 AND status = 'running'`,
                [generationId, attempt],
              )
              generationTtftSeconds.observe({ model: gen.model }, (Date.now() - gen.started_at.getTime()) / 1000)
            }
            lastTokenAt = Date.now()
            output += event.text
            pending += event.text
            outputTokens++
          } else {
            outcome = event
          }
        }
      } catch (err) {
        if (entry.reason) break
        // Retry only before the first token: after that the user has seen part of an answer,
        // and starting over would show a different one and bill twice.
        const retryable = err instanceof RetryableModelError && outputTokens === 0 && startAttempt < MAX_START_ATTEMPTS
        if (!retryable) {
          const code = err instanceof ModelRequestError ? err.code : 'MODEL_UNAVAILABLE'
          outcome = { type: 'error', code, message: (err as Error).message }
          break
        }
        const delay = Math.max((err as RetryableModelError).retryAfterMs, 250 * 2 ** (startAttempt - 1))
        log.info({ delay, startAttempt }, 'model not ready, retrying before first token')
        await sleep(delay)
      }
    }

    if (entry.reason === 'cancelled') await finalize('cancelled', { finishReason: 'cancelled' })
    else if (entry.reason === 'timeout') {
      await finalize('failed', { errorCode: 'MODEL_TIMEOUT', errorMessage: 'The model stopped sending output' })
    } else if (entry.reason === 'shutdown') {
      await finalize('failed', {
        errorCode: 'EXECUTOR_SHUTDOWN',
        errorMessage: 'The server restarted while this answer was being written',
      })
    } else if (entry.reason === 'lease_lost') {
      log.warn('lease lost; another process already finalized this generation')
    } else if (outcome?.type === 'done') {
      await finalize('completed', { finishReason: outcome.finishReason })
    } else if (outcome?.type === 'error') {
      await finalize('failed', { errorCode: outcome.code, errorMessage: outcome.message })
    }
  } catch (err) {
    log.error({ err }, 'generation execution crashed')
    await finalize('failed', {
      errorCode: 'EXECUTOR_ERROR',
      errorMessage: 'Something went wrong while writing this answer',
    }).catch((finalizeErr) => log.error({ err: finalizeErr }, 'could not record failure; sweeper will'))
  } finally {
    clearInterval(flushTimer)
    clearInterval(checkpointTimer)
    clearInterval(heartbeat)
    inFlight.delete(generationId)
    await publishChain.catch(() => undefined)
  }
}
