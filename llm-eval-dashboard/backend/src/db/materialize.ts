/**
 * Materializes a finished run in-process, for the seed. It uses the exact
 * functions a live worker uses (template rendering, the mock model's
 * planGeneration, the scorers, the judge's grade), so a live run with the
 * same pins produces the same outputs and scores. Timings and transient
 * failures are simulated deterministically from the task key.
 * @module db/materialize
 */
import { createHash } from 'node:crypto'
import { MODELS, sampleSeed } from '../model/catalog.js'
import { planGeneration } from '../model/generator.js'
import { grade } from '../judge/grader.js'
import { isDeterministic, scoreDeterministic, type ScorerKind } from '../shared/scorers.js'
import { mulberry32 } from '../shared/stats.js'
import { renderTemplate } from '../shared/template.js'

export interface MaterializeInput {
  runId: string
  createdAt: Date
  samples: number
  concurrency: number
  cases: { id: string; caseKey: string; input: Record<string, unknown>; reference: string }[]
  prompt: { system: string; template: string }
  config: { model: string; temperature: number; maxTokens: number; seed: number }
  scorers: { id: string; kind: ScorerKind; config: Record<string, unknown> }[]
  transientRate: number
  cancelAfter?: number
}

export interface TaskRow {
  id: string
  case_id: string
  case_key: string
  sample_index: number
  status: 'succeeded' | 'errored' | 'cancelled'
  attempts: number
  output: string | null
  finish_reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  queue_ms: number | null
  ttft_ms: number | null
  generation_ms: number | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
}

export interface AttemptRow {
  case_result_id: string
  attempt: number
  worker_id: string
  outcome: string
  error_code: string | null
  http_status: number | null
  delay_ms: number | null
  started_at: string
  finished_at: string
}

export interface ScoreRow {
  case_result_id: string
  scorer_version_id: string
  score: number
  passed: boolean
  confidence: number | null
  rationale: string
}

export function caseResultId(runId: string, caseId: string, sample: number): string {
  return `cr_${createHash('md5').update(`${runId}:${caseId}:${sample}`).digest('hex').slice(0, 20)}`
}

const TRANSIENT = [
  { code: 'rate_limited', http: 429, msg: 'Simulated rate limit' },
  { code: 'overloaded', http: 529, msg: 'Simulated overload' },
  { code: 'stream_disconnected', http: null, msg: 'stream ended before the done event' },
]

export function materializeRun(m: MaterializeInput) {
  const spec = MODELS[m.config.model]
  const tasks: TaskRow[] = []
  const attempts: AttemptRow[] = []
  const scores: ScoreRow[] = []
  const order: { c: MaterializeInput['cases'][number]; s: number }[] = []
  for (let s = 0; s < m.samples; s++) for (const c of m.cases) order.push({ c, s })
  const cutoff = m.cancelAfter !== undefined ? Math.floor(order.length * m.cancelAfter) : Infinity
  const slotFree = Array.from({ length: m.concurrency }, () => 0)
  let lastFinish = 0

  order.forEach(({ c, s }, index) => {
    const id = caseResultId(m.runId, c.id, s)
    const rand = mulberry32(createHash('md5').update(id).digest().readUInt32LE(0))
    const base: Omit<TaskRow, 'status'> = { id, case_id: c.id, case_key: c.caseKey, sample_index: s, attempts: 0, output: null, finish_reason: null, input_tokens: null, output_tokens: null, queue_ms: null, ttft_ms: null, generation_ms: null, error_code: null, error_message: null, started_at: null, finished_at: null }
    if (index >= cutoff) {
      tasks.push({ ...base, status: 'cancelled', finish_reason: 'cancelled' })
      return
    }
    const slot = slotFree.indexOf(Math.min(...slotFree))
    let t = slotFree[slot]
    const queueMs = Math.round(t)
    const at = (ms: number) => new Date(m.createdAt.getTime() + ms).toISOString()
    let attempt = 0
    const worker = `worker-${(slot % 2) + 1}`
    if (rand() < m.transientRate) {
      const f = TRANSIENT[Math.floor(rand() * TRANSIENT.length)]
      attempt++
      const dur = 40 + rand() * 200
      const delay = f.code === 'rate_limited' ? 1000 : Math.round(rand() * 500)
      attempts.push({ case_result_id: id, attempt, worker_id: worker, outcome: 'retry_scheduled', error_code: f.code, http_status: f.http, delay_ms: delay, started_at: at(t), finished_at: at(t + dur) })
      t += dur + delay
    }
    const plan = planGeneration({ model: m.config.model, system: m.prompt.system, prompt: renderTemplate(m.prompt.template, c.input), temperature: m.config.temperature, maxTokens: m.config.maxTokens, seed: sampleSeed(m.config.seed, s) })
    attempt++
    if (!plan.ok) {
      const dur = 20 + rand() * 30
      attempts.push({ case_result_id: id, attempt, worker_id: worker, outcome: 'errored', error_code: plan.errorType, http_status: 400, delay_ms: null, started_at: at(t), finished_at: at(t + dur) })
      tasks.push({ ...base, status: 'errored', attempts: attempt, queue_ms: queueMs, error_code: plan.errorType, error_message: `${plan.message} (permanent: ${plan.errorType})`, started_at: at(slotFree[slot]), finished_at: at(t + dur) })
      slotFree[slot] = t + dur
      lastFinish = Math.max(lastFinish, t + dur)
      return
    }
    const ttft = Math.round((spec?.ttftMs ?? 300) * (0.85 + rand() * 0.3))
    const gen = Math.round((plan.outputTokens * 1000) / (spec?.tokensPerSecond ?? 60) * (0.85 + rand() * 0.3))
    attempts.push({ case_result_id: id, attempt, worker_id: worker, outcome: 'succeeded', error_code: null, http_status: null, delay_ms: null, started_at: at(t), finished_at: at(t + ttft + gen) })
    tasks.push({
      ...base,
      status: 'succeeded',
      attempts: attempt,
      output: plan.text,
      finish_reason: plan.finishReason,
      input_tokens: plan.inputTokens,
      output_tokens: plan.outputTokens,
      queue_ms: queueMs,
      ttft_ms: ttft,
      generation_ms: gen,
      started_at: at(slotFree[slot]),
      finished_at: at(t + ttft + gen),
    })
    slotFree[slot] = t + ttft + gen
    lastFinish = Math.max(lastFinish, t + ttft + gen)
    for (const sc of m.scorers) {
      if (sc.kind === 'human') continue
      if (isDeterministic(sc.kind)) {
        const r = scoreDeterministic(sc.kind, sc.config, plan.text, c.reference)
        scores.push({ case_result_id: id, scorer_version_id: sc.id, score: r.score, passed: r.passed, confidence: null, rationale: r.rationale })
      } else {
        const cfg = sc.config as { rubric: string; strictness: 'lenient' | 'strict'; passGrade: number }
        const g = grade({ rubric: cfg.rubric, strictness: cfg.strictness, passGrade: cfg.passGrade, input: JSON.stringify(c.input), output: plan.text, reference: c.reference })
        scores.push({ case_result_id: id, scorer_version_id: sc.id, score: g.score, passed: g.passed, confidence: g.confidence, rationale: g.rationale })
      }
    }
  })
  return { tasks, attempts, scores, durationMs: lastFinish }
}
