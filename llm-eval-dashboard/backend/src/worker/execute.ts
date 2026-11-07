/**
 * Executes one claimed generation task: render, call the model, classify the
 * outcome, write it fenced by the lease token, score inline.
 *
 * While the call runs, a heartbeat extends the lease. If the heartbeat finds
 * the lease gone, or the run is cancelled (NOTIFY or poll), the call is
 * aborted: the mock sees the disconnect and stops generating.
 * @module worker/execute
 */
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { leasesReclaimed, modelLatency, scoresFinished, tasksFinished } from '../shared/metrics.js'
import { decideRetry } from '../shared/retry.js'
import { isDeterministic, scoreDeterministic, type ScorerKind } from '../shared/scorers.js'
import { renderTemplate } from '../shared/template.js'
import { sampleSeed } from '../model/catalog.js'
import { callJudge, callModel } from './model-client.js'
import { loadCase, loadRunContext } from './run-context.js'
import { finishScore, type ClaimedScore } from './score-tasks.js'
import { completeTask, failTask, finalizeRun, heartbeat, markSuperseded, type ClaimedTask, type InlineScore } from './tasks.js'

/** In-flight calls by run, so a cancel can abort them. */
export class InflightRegistry {
  private readonly byRun = new Map<string, Set<AbortController>>()

  add(runId: string, controller: AbortController): () => void {
    let set = this.byRun.get(runId)
    if (!set) {
      set = new Set()
      this.byRun.set(runId, set)
    }
    set.add(controller)
    return () => {
      set.delete(controller)
      if (set.size === 0) this.byRun.delete(runId)
    }
  }

  abortRun(runId: string, reason: string): number {
    const set = this.byRun.get(runId)
    if (!set) return 0
    for (const c of set) c.abort(reason)
    return set.size
  }

  runIds(): string[] {
    return [...this.byRun.keys()]
  }
}

const policy = () => ({ maxAttempts: config.worker.maxAttempts, baseMs: config.worker.retryBaseMs, capMs: config.worker.retryCapMs })

export async function executeGeneration(task: ClaimedTask, inflight: InflightRegistry): Promise<void> {
  const log = logger.child({ task: task.id, run: task.runId, attempt: task.attempt })
  if (task.reclaimed) {
    leasesReclaimed.inc({ kind: 'generation' })
    log.warn('re-claimed a task whose lease expired (previous worker died or stalled)')
  }
  const ctx = await loadRunContext(pool, task.runId)
  const data = await loadCase(pool, task.caseId)
  const controller = new AbortController()
  const unregister = inflight.add(task.runId, controller)
  let leaseLost = false
  const beat = setInterval(() => {
    heartbeat(pool, task.id, task.leaseToken, config.worker.leaseMs)
      .then((ok) => {
        if (!ok && !controller.signal.aborted) {
          leaseLost = true
          controller.abort('lease_lost')
        }
      })
      .catch((err) => log.warn({ err: err.message }, 'heartbeat failed'))
  }, Math.max(500, Math.floor(config.worker.leaseMs / 3)))

  try {
    modelLatency.observe({ phase: 'queue' }, task.queueMs / 1000)
    const result = await callModel(
      { model: ctx.model, system: ctx.system, prompt: renderTemplate(ctx.template, data.input), temperature: ctx.temperature, maxTokens: ctx.maxTokens, seed: sampleSeed(ctx.seed, task.sampleIndex) },
      { baseUrl: config.modelUrl, timeoutMs: config.worker.modelTimeoutMs, signal: controller.signal, runId: task.runId, taskId: task.id },
    )
    clearInterval(beat)

    if (result.ok) {
      modelLatency.observe({ phase: 'ttft' }, result.ttftMs / 1000)
      modelLatency.observe({ phase: 'generation' }, result.generationMs / 1000)
      const scores: InlineScore[] = ctx.scorers.map((s) => {
        if (!isDeterministic(s.kind)) return { scorerVersionId: s.id, status: 'pending' }
        try {
          const r = scoreDeterministic(s.kind, s.config, result.text, data.reference)
          scoresFinished.inc({ kind: s.kind, outcome: 'scored' })
          return { scorerVersionId: s.id, status: 'scored', score: r.score, passed: r.passed, rationale: r.rationale }
        } catch (err) {
          // A scorer bug must not lose the output: leave it pending for a re-score.
          log.error({ err, scorer: s.id }, 'inline scoring failed')
          return { scorerVersionId: s.id, status: 'pending' }
        }
      })
      const client = await pool.connect()
      try {
        const ok = await completeTask(client, task, { output: result.text, finishReason: result.finishReason, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ttftMs: result.ttftMs, generationMs: result.generationMs }, scores)
        if (!ok) {
          await markSuperseded(pool, task.id, task.attempt)
          tasksFinished.inc({ outcome: 'superseded', error: '' })
          log.warn('lease lost before the result was written; discarded (the new owner writes it)')
        } else tasksFinished.inc({ outcome: 'succeeded', error: '' })
      } finally {
        client.release()
      }
    } else if (result.aborted) {
      if (leaseLost || result.aborted === 'lease_lost') {
        await markSuperseded(pool, task.id, task.attempt)
        tasksFinished.inc({ outcome: 'superseded', error: 'lease_lost' })
      } else {
        await failTask(pool, task, { kind: 'cancelled', partial: result.partial })
        tasksFinished.inc({ outcome: 'cancelled', error: '' })
      }
    } else {
      const decision = decideRetry(result.failure, task.roundAttempts, policy())
      if (decision.action === 'retry') {
        await failTask(pool, task, { kind: 'retry', delayMs: decision.delayMs, errorCode: result.failure.kind, errorMessage: result.failure.message, httpStatus: result.failure.httpStatus })
        tasksFinished.inc({ outcome: 'retry_scheduled', error: result.failure.kind })
        log.info({ failure: result.failure.kind, delayMs: decision.delayMs }, 'transient failure; retry scheduled')
      } else {
        await failTask(pool, task, { kind: 'errored', errorCode: result.failure.kind, errorMessage: `${result.failure.message} (${decision.reason})`, httpStatus: result.failure.httpStatus })
        tasksFinished.inc({ outcome: 'errored', error: result.failure.kind })
        log.info({ failure: result.failure.kind, reason: decision.reason }, 'task errored')
      }
    }
  } finally {
    clearInterval(beat)
    unregister()
  }
  await finalizeRun(pool, task.runId)
}

export async function executeScore(task: ClaimedScore, inflight: InflightRegistry): Promise<void> {
  const log = logger.child({ caseResult: task.caseResultId, scorer: task.scorerVersionId })
  if (task.reclaimed) leasesReclaimed.inc({ kind: 'score' })
  const kind = task.kind as ScorerKind
  if (isDeterministic(kind)) {
    try {
      const r = scoreDeterministic(kind, task.config, task.output, task.reference)
      await finishScore(pool, task, { kind: 'scored', score: r.score, passed: r.passed, rationale: r.rationale })
      scoresFinished.inc({ kind, outcome: 'scored' })
    } catch (err) {
      await finishScore(pool, task, { kind: 'errored', errorCode: 'scorer_error', errorMessage: err instanceof Error ? err.message : String(err) })
      scoresFinished.inc({ kind, outcome: 'errored' })
    }
  } else if (kind === 'model_graded') {
    const controller = new AbortController()
    const unregister = inflight.add(task.runId, controller)
    try {
      const c = task.config as { rubric: string; strictness: 'lenient' | 'strict'; passGrade: number }
      const result = await callJudge(
        { rubric: c.rubric, strictness: c.strictness, passGrade: c.passGrade, input: JSON.stringify(task.input), output: task.output, reference: task.reference },
        { baseUrl: config.judgeUrl, timeoutMs: config.worker.judgeTimeoutMs, signal: controller.signal, runId: task.runId },
      )
      if (result.ok) {
        await finishScore(pool, task, { kind: 'scored', score: result.score, passed: result.passed, rationale: result.rationale, confidence: result.confidence })
        scoresFinished.inc({ kind, outcome: 'scored' })
      } else if (result.aborted) {
        await finishScore(pool, task, { kind: 'errored', errorCode: 'cancelled', errorMessage: 'run cancelled' })
      } else {
        const decision = decideRetry(result.failure, task.attempts, policy())
        if (decision.action === 'retry') await finishScore(pool, task, { kind: 'retry', delayMs: decision.delayMs, errorCode: result.failure.kind, errorMessage: result.failure.message })
        else await finishScore(pool, task, { kind: 'errored', errorCode: result.failure.kind, errorMessage: `${result.failure.message} (${decision.reason})` })
        scoresFinished.inc({ kind, outcome: decision.action === 'retry' ? 'retry_scheduled' : 'errored' })
        log.info({ failure: result.failure.kind, decision: decision.action }, 'judge call failed')
      }
    } finally {
      unregister()
    }
  } else {
    await finishScore(pool, task, { kind: 'errored', errorCode: 'not_automatable', errorMessage: `${kind} scores come from annotations` })
  }
  await finalizeRun(pool, task.runId)
}
