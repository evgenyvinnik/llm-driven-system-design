/**
 * Executes one run: claim → stream from the model → publish deltas → finalize.
 *
 * Ownership is decided in PostgreSQL, not by the queue. The claim is a
 * conditional UPDATE (status 'queued' → 'running') that also increments
 * `attempt` and sets a lease. Every later write is conditioned on that
 * attempt still owning a running row, so an executor that stalled past its
 * lease (and was failed by the sweeper) cannot overwrite the outcome.
 */
import { redis } from '../shared/cache.js'
import { estimateTokens } from '../shared/catalog.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { runQueueSeconds, runsFinished, runTtftSeconds } from '../shared/metrics.js'
import { appendRunEvent, type TerminalStatus } from '../shared/run-events.js'
import { ModelRequestError, RetryableModelError, streamModel, type ModelEvent } from './model-client.js'

export type AbortReason = 'cancelled' | 'lease_lost' | 'shutdown' | 'timeout'

export interface InFlightRun {
  controller: AbortController
  reason?: AbortReason
}

export function abortRun(entry: InFlightRun, reason: AbortReason): void {
  if (entry.reason) return
  entry.reason = reason
  entry.controller.abort()
}

const FLUSH_INTERVAL_MS = 50
const MAX_START_ATTEMPTS = 3
const IDLE_TIMEOUT_MS = 30_000

interface ClaimedRun {
  attempt: number
  model: string
  config: { temperature: number; topP: number; maxTokens: number }
  rendered_system: string
  rendered_input: string
  created_at: Date
  started_at: Date
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function executeRun(runId: string, executorId: string, inFlight: Map<string, InFlightRun>): Promise<void> {
  const claim = await pool.query<ClaimedRun>(
    `UPDATE runs
        SET status = 'running', attempt = attempt + 1, lease_owner = $2,
            lease_expires_at = now() + make_interval(secs => $3), started_at = now()
      WHERE id = $1 AND status = 'queued'
      RETURNING attempt, model, config, rendered_system, rendered_input, created_at, started_at`,
    [runId, executorId, config.leaseSeconds],
  )
  // Already claimed, cancelled while queued, or finished: the queue entry was a duplicate.
  if (claim.rows.length === 0) return

  const run = claim.rows[0]
  const { attempt } = run
  const log = logger.child({ runId, attempt })
  const entry: InFlightRun = { controller: new AbortController() }
  inFlight.set(runId, entry)
  runQueueSeconds.observe((run.started_at.getTime() - run.created_at.getTime()) / 1000)

  let output = ''
  let outputTokens = 0
  let pending = ''
  let publishChain: Promise<unknown> = Promise.resolve()
  const flush = () => {
    if (!pending) return publishChain
    const text = pending
    pending = ''
    publishChain = publishChain.then(() => appendRunEvent(redis, runId, { type: 'delta', text }))
    return publishChain
  }
  const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS)

  let lastTokenAt = Date.now()
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const { rows } = await pool.query<{ cancel_requested_at: Date | null }>(
          `UPDATE runs SET lease_expires_at = now() + make_interval(secs => $4)
            WHERE id = $1 AND attempt = $2 AND status = 'running' AND lease_owner = $3
            RETURNING cancel_requested_at`,
          [runId, attempt, executorId, config.leaseSeconds],
        )
        if (rows.length === 0) abortRun(entry, 'lease_lost')
        else if (rows[0].cancel_requested_at) abortRun(entry, 'cancelled') // covers a missed pub/sub message
        if (Date.now() - lastTokenAt > IDLE_TIMEOUT_MS) abortRun(entry, 'timeout')
      } catch (err) {
        log.warn({ err }, 'heartbeat failed')
      }
    })()
  }, config.heartbeatMs)

  async function finalize(
    status: TerminalStatus,
    fields: { finishReason?: string; errorCode?: string; errorMessage?: string; inputTokens?: number },
  ): Promise<void> {
    // PostgreSQL is the record of the outcome; a Valkey hiccup must not stop it being written.
    await flush().catch((err) => log.warn({ err }, 'could not publish final output delta'))
    const inputTokens = fields.inputTokens ?? estimateTokens(run.rendered_system + run.rendered_input)
    const { rows } = await pool.query<{
      created_at: Date
      started_at: Date
      first_token_at: Date | null
      finished_at: Date
    }>(
      `UPDATE runs
          SET status = $3, output = $4, output_truncated = $5, finish_reason = $6, error_code = $7,
              error_message = $8, input_tokens = $9, output_tokens = $10, finished_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND attempt = $2 AND status = 'running'
        RETURNING created_at, started_at, first_token_at, finished_at`,
      [
        runId,
        attempt,
        status,
        output,
        status !== 'completed' && output.length > 0,
        fields.finishReason ?? null,
        fields.errorCode ?? null,
        fields.errorMessage ?? null,
        inputTokens,
        outputTokens,
      ],
    )
    if (rows.length === 0) {
      log.warn({ status }, 'run no longer owned by this attempt; outcome discarded')
      return
    }
    const r = rows[0]
    const span = (a: Date | null, b: Date | null) => (a && b ? b.getTime() - a.getTime() : null)
    await appendRunEvent(redis, runId, {
      type: 'end',
      status,
      outputTruncated: status !== 'completed' && output.length > 0,
      finishReason: fields.finishReason ?? null,
      errorCode: fields.errorCode ?? null,
      errorMessage: fields.errorMessage ?? null,
      usage: {
        inputTokens,
        outputTokens,
        queueMs: span(r.created_at, r.started_at),
        ttftMs: span(r.started_at, r.first_token_at),
        durationMs: span(r.started_at, r.finished_at),
      },
      at: r.finished_at.toISOString(),
    })
    runsFinished.inc({ model: run.model, status })
    log.info({ status, outputTokens, errorCode: fields.errorCode }, 'run finished')
  }

  try {
    await appendRunEvent(redis, runId, { type: 'status', status: 'running', attempt, at: run.started_at.toISOString() })
    // A cancel that raced the claim may have been published before we subscribed to it.
    const { rows: cancelCheck } = await pool.query('SELECT cancel_requested_at FROM runs WHERE id = $1', [runId])
    if (cancelCheck[0]?.cancel_requested_at) abortRun(entry, 'cancelled')

    let outcome: ModelEvent | null = null
    for (let startAttempt = 1; !outcome && !entry.reason; startAttempt++) {
      try {
        for await (const event of streamModel(
          {
            model: run.model,
            system: run.rendered_system,
            input: run.rendered_input,
            temperature: run.config.temperature,
            topP: run.config.topP,
            maxTokens: run.config.maxTokens,
          },
          entry.controller.signal,
        )) {
          if (event.type === 'token') {
            if (outputTokens === 0) {
              await pool.query(
                `UPDATE runs SET first_token_at = now() WHERE id = $1 AND attempt = $2 AND status = 'running'`,
                [runId, attempt],
              )
              runTtftSeconds.observe({ model: run.model }, (Date.now() - run.started_at.getTime()) / 1000)
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
      await finalize('failed', { errorCode: 'EXECUTOR_SHUTDOWN', errorMessage: 'The executor shut down during the run' })
    } else if (entry.reason === 'lease_lost') {
      log.warn('lease lost; another process already finalized this run')
    } else if (outcome?.type === 'done') {
      await finalize('completed', { finishReason: outcome.finishReason, inputTokens: outcome.usage.inputTokens })
    } else if (outcome?.type === 'error') {
      await finalize('failed', { errorCode: outcome.code, errorMessage: outcome.message })
    }
  } catch (err) {
    log.error({ err }, 'run execution crashed')
    await finalize('failed', { errorCode: 'EXECUTOR_ERROR', errorMessage: 'The executor hit an internal error' }).catch(
      (finalizeErr) => log.error({ err: finalizeErr }, 'could not record failure; sweeper will'),
    )
  } finally {
    clearInterval(flushTimer)
    clearInterval(heartbeat)
    inFlight.delete(runId)
    await publishChain.catch(() => undefined)
  }
}
