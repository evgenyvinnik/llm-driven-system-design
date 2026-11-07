/**
 * Executes one answer run on the API instance that accepted it:
 *
 *   queued → running → (cache hit | retrieve → re-check → prompt → stream) → completed
 *                                                                       ↘ cancelled | failed
 *
 * Every step appends to the run's Valkey event stream (any instance can serve
 * the SSE), and the run row is the durable record: partial output is flushed
 * with each heartbeat, so a mid-stream model failure, a Stop, or even this
 * instance dying (the sweeper fails runs whose heartbeat stops) leaves the
 * text produced so far. Usage is recorded on every run: input/output tokens,
 * queue time, retrieval time, time to first token and generation time.
 * @module api/services/answer-runner
 */
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { logger } from '../../shared/logger.js'
import { answerCache, runsFinished, ttftSeconds } from '../../shared/metrics.js'
import { estimateTokens } from '../../shared/text.js'
import { lookupAnswer, storeAnswer, type ContextDoc } from './answer-cache.js'
import { extractCitations } from './citations.js'
import type { SourceRef } from './dto.js'
import { ModelError, streamModel } from './model-client.js'
import { summarizeDrops } from './recheck.js'
import { retrieve } from './retrieval.js'
import { appendEvent, onCancel } from './run-events.js'

const controllers = new Map<string, AbortController>()
let cancelHooked = false

function hookCancel(): void {
  if (cancelHooked) return
  cancelHooked = true
  onCancel((runId) => controllers.get(runId)?.abort())
}

export const SYSTEM_PROMPT =
  'You answer questions using only the numbered sources provided. Quote or closely paraphrase the source text and put the ' +
  'source number in square brackets after each claim, like [2]. If the sources do not contain the answer, reply exactly: ' +
  '"That information was not found in your documents."'

export function buildPrompt(question: string, sources: (SourceRef & { text: string })[]): string {
  const blocks = sources.map((s) => `<source id="${s.n}" title="${s.title.replace(/"/g, "'")}" version="${s.versionNo}">${s.text}</source>`).join('\n')
  return `<sources>\n${blocks}\n</sources>\n\nQuestion: ${question}`
}

export interface RunContext {
  orgId: string
  userId: string
  claimedGroups: string[]
}

async function finish(
  runId: string,
  status: 'completed' | 'cancelled' | 'failed',
  fields: { output: string; error?: string | null; citations?: unknown; inputTokens?: number | null; outputTokens?: number | null; model?: string | null },
): Promise<void> {
  await pool.query(
    `UPDATE answer_runs SET status = $2, output_text = $3, error = $4, citations = COALESCE($5, citations),
       input_tokens = COALESCE($6, input_tokens), output_tokens = COALESCE($7, output_tokens), model = COALESCE($8, model),
       finished_at = now(),
       generation_ms = CASE WHEN first_token_at IS NULL THEN NULL ELSE (extract(epoch FROM now() - first_token_at) * 1000)::int END
     WHERE id = $1 AND status = 'running'`,
    [runId, status, fields.output, fields.error ?? null, fields.citations ? JSON.stringify(fields.citations) : null, fields.inputTokens ?? null, fields.outputTokens ?? null, fields.model ?? null],
  )
  runsFinished.inc({ status })
}

export async function executeRun(runId: string, ctx: RunContext): Promise<void> {
  hookCancel()
  const { rows } = await pool.query<{ question: string }>(
    `UPDATE answer_runs SET status = 'running', started_at = now(), heartbeat_at = now(), executor = $2,
       queue_ms = (extract(epoch FROM now() - created_at) * 1000)::int
     WHERE id = $1 AND status = 'queued' AND cancel_requested_at IS NULL RETURNING question`,
    [runId, config.instanceId],
  )
  if (!rows[0]) {
    const cancelled = await pool.query(
      `UPDATE answer_runs SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued' AND cancel_requested_at IS NOT NULL RETURNING id`,
      [runId],
    )
    if (cancelled.rowCount) await appendEvent(runId, 'cancelled', { outputText: '' })
    return
  }
  const question = rows[0].question
  await appendEvent(runId, 'status', { status: 'running', executor: config.instanceId })

  const ac = new AbortController()
  controllers.set(runId, ac)
  let partial = ''
  let flushed = ''
  let deltas = 0
  let promptTokens: number | null = null
  const beat = setInterval(() => {
    const out = partial
    void pool
      .query<{ cancel_requested_at: Date | null }>(
        `UPDATE answer_runs SET heartbeat_at = now(), output_text = CASE WHEN $2::text <> '' THEN $2 ELSE output_text END
          WHERE id = $1 AND status = 'running' RETURNING cancel_requested_at`,
        [runId, out === flushed ? '' : out],
      )
      .then((r) => {
        flushed = out
        if (r.rows[0]?.cancel_requested_at) ac.abort()
      })
      .catch(() => undefined)
  }, 1000)

  try {
    // 1. Answer cache, validated against the source of truth on read.
    const cached = await lookupAnswer(ctx.orgId, ctx.userId, question)
    answerCache.inc({ result: cached.status })
    if (cached.status === 'hit') {
      const entry = cached.entry
      const cacheInfo = { status: 'hit', fromRunId: entry.runId, cachedAt: entry.createdAt, validatedDocuments: entry.context.length }
      await pool.query(
        `UPDATE answer_runs SET cache = $2, sources = $3, retrieval = $4, retrieval_ms = 0, first_token_at = now(),
           ttft_ms = (extract(epoch FROM now() - started_at) * 1000)::int WHERE id = $1`,
        [runId, cacheInfo, JSON.stringify(entry.sources), { fromCache: true }],
      )
      await appendEvent(runId, 'cache', cacheInfo)
      await appendEvent(runId, 'retrieval', { sources: entry.sources, fromCache: true })
      partial = entry.answer
      await appendEvent(runId, 'delta', { text: entry.answer })
      await finish(runId, 'completed', { output: entry.answer, citations: entry.citations, inputTokens: 0, outputTokens: 0, model: 'answer-cache' })
      await appendEvent(runId, 'completed', { citations: entry.citations, cache: cacheInfo })
      return
    }
    const cacheInfo = cached.status === 'rejected' ? { status: 'rejected', reason: cached.reason } : { status: 'miss' }
    await pool.query(`UPDATE answer_runs SET cache = $2 WHERE id = $1`, [runId, cacheInfo])
    await appendEvent(runId, 'cache', cacheInfo)

    // 2. Retrieval: pre-filtered index search, then the source-of-truth re-check.
    const r = await retrieve({ orgId: ctx.orgId, userId: ctx.userId, claimedGroups: ctx.claimedGroups, question })
    const sources = r.kept.map((k, i) => ({
      n: i + 1,
      documentId: k.truth.documentId,
      versionId: k.truth.versionId,
      versionNo: k.truth.versionNo,
      title: k.truth.title,
      chunkId: k.truth.chunkId,
      ordinal: k.truth.ordinal,
      heading: k.truth.heading,
      charStart: k.truth.charStart,
      charEnd: k.truth.charEnd,
      text: k.truth.text,
    }))
    const sourceRefs: SourceRef[] = sources.map(({ text: _text, ...ref }) => ref)
    const retrievalInfo = {
      candidates: r.candidates,
      belowThreshold: r.belowThreshold,
      kept: r.kept.length,
      dropped: summarizeDrops(r.dropped),
      droppedDocs: r.dropped.map((d) => ({ documentId: d.candidate.documentId, versionId: d.candidate.versionId, reason: d.reason, staleIndex: d.staleIndex })),
      claimedGroups: ctx.claimedGroups,
      liveGroups: r.liveGroups,
      ms: r.ms,
    }
    await pool.query(`UPDATE answer_runs SET sources = $2, retrieval = $3, retrieval_ms = $4 WHERE id = $1`, [runId, JSON.stringify(sourceRefs), retrievalInfo, r.ms])
    const { droppedDocs: _hidden, ...publicRetrieval } = retrievalInfo
    await appendEvent(runId, 'retrieval', { sources: sourceRefs, ...publicRetrieval })
    if (ac.signal.aborted) throw new ModelError('cancelled', 'aborted')

    // 3. Model, streamed. The first delta stamps time to first token.
    const prompt = buildPrompt(question, sources)
    promptTokens = estimateTokens(SYSTEM_PROMPT + prompt)
    let first = true
    const result = await streamModel({
      system: SYSTEM_PROMPT,
      user: prompt,
      maxTokens: config.answers.maxOutputTokens,
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(config.answers.modelTimeoutMs)]),
      onDelta: async (text) => {
        if (first) {
          first = false
          const t = await pool.query<{ ttft_ms: number }>(
            `UPDATE answer_runs SET first_token_at = now(), ttft_ms = (extract(epoch FROM now() - started_at) * 1000)::int WHERE id = $1 RETURNING ttft_ms`,
            [runId],
          )
          if (t.rows[0]) ttftSeconds.observe(t.rows[0].ttft_ms / 1000)
        }
        partial += text
        deltas += 1
        await appendEvent(runId, 'delta', { text })
      },
    })
    const citations = extractCitations(result.text, sources)
    await finish(runId, 'completed', {
      output: result.text,
      citations,
      inputTokens: result.inputTokens ?? promptTokens,
      outputTokens: result.outputTokens ?? estimateTokens(result.text),
      model: result.model,
    })
    const seen = new Set<string>()
    const context: ContextDoc[] = []
    for (const k of r.kept) {
      if (seen.has(k.truth.documentId)) continue
      seen.add(k.truth.documentId)
      context.push({ documentId: k.truth.documentId, versionId: k.truth.versionId, aclEpoch: k.truth.aclEpoch })
    }
    await storeAnswer(ctx.orgId, ctx.userId, {
      runId,
      question,
      answer: result.text,
      sources: sourceRefs,
      citations,
      context,
      createdAt: new Date().toISOString(),
    }).catch((err) => logger.warn({ err: (err as Error).message }, 'answer cache write failed'))
    await appendEvent(runId, 'completed', { citations, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens } })
  } catch (err) {
    const cancelled = ac.signal.aborted
    const message = cancelled ? 'Stopped by the user' : err instanceof ModelError ? err.message : `answer failed: ${(err as Error).message}`
    if (!cancelled) logger.warn({ runId, err: message }, 'answer run failed')
    // Usage is recorded on every run: the prompt was sent and the partial output was generated (and billed).
    await finish(runId, cancelled ? 'cancelled' : 'failed', {
      output: partial,
      error: cancelled ? null : message,
      inputTokens: promptTokens,
      outputTokens: promptTokens === null ? null : deltas,
    }).catch(() => undefined)
    await appendEvent(runId, cancelled ? 'cancelled' : 'failed', { error: cancelled ? null : message, outputText: partial }).catch(() => undefined)
  } finally {
    clearInterval(beat)
    controllers.delete(runId)
  }
}

/** Aborts a run executing on this instance (other instances hear it on the cancel channel). */
export function abortLocal(runId: string): boolean {
  const c = controllers.get(runId)
  if (!c) return false
  c.abort()
  return true
}
