/**
 * Per-case view of a run: every sample's output, usage, error and scores, and
 * per-case statistics per scorer version (mean, variance, flaky).
 * @module api/services/cases
 */
import { aggregateCases, type TaskStatus } from '../../shared/aggregate.js'
import type { Queryable } from '../../shared/db.js'

export interface SampleView {
  id: string
  sampleIndex: number
  status: TaskStatus
  attempts: number
  output: string | null
  finishReason: string | null
  errorCode: string | null
  errorMessage: string | null
  inputTokens: number | null
  outputTokens: number | null
  queueMs: number | null
  ttftMs: number | null
  generationMs: number | null
  scores: Record<string, { status: string; score: number | null; passed: boolean | null; confidence: number | null; rationale: string | null; errorCode: string | null }>
  annotation: { label: 'pass' | 'fail'; note: string; by: string; at: string } | null
}

export interface CaseView {
  caseId: string
  caseKey: string
  ordinal: number
  tags: string[]
  input: Record<string, unknown>
  reference: string
  samples: SampleView[]
  stats: Record<string, { mean: number | null; variance: number; flaky: boolean; scored: number; errored: number }>
}

export async function loadCaseTable(db: Queryable, runId: string): Promise<CaseView[]> {
  const [cases, scores] = await Promise.all([
    db.query<{
      id: string
      case_id: string
      case_key: string
      ordinal: number
      tags: string[]
      input: Record<string, unknown>
      reference: string
      sample_index: number
      status: TaskStatus
      attempts: number
      output: string | null
      finish_reason: string | null
      error_code: string | null
      error_message: string | null
      input_tokens: number | null
      output_tokens: number | null
      queue_ms: number | null
      ttft_ms: number | null
      generation_ms: number | null
      label: 'pass' | 'fail' | null
      note: string | null
      annotated_by: string | null
      annotated_at: Date | null
    }>(
      `SELECT cr.id, cr.case_id, cr.case_key, dc.ordinal, dc.tags, dc.input, dc.reference, cr.sample_index, cr.status, cr.attempts,
              cr.output, cr.finish_reason, cr.error_code, cr.error_message, cr.input_tokens, cr.output_tokens, cr.queue_ms, cr.ttft_ms, cr.generation_ms,
              a.label, a.note, u.display_name AS annotated_by, a.updated_at AS annotated_at
         FROM case_results cr
         JOIN dataset_cases dc ON dc.id = cr.case_id
         LEFT JOIN annotations a ON a.case_result_id = cr.id
         LEFT JOIN users u ON u.id = a.annotated_by
        WHERE cr.run_id = $1
        ORDER BY dc.ordinal, cr.sample_index`,
      [runId],
    ),
    db.query<{ case_result_id: string; scorer_version_id: string; status: string; score: number | null; passed: boolean | null; confidence: number | null; rationale: string | null; error_code: string | null }>(
      'SELECT case_result_id, scorer_version_id, status, score, passed, confidence, rationale, error_code FROM scores WHERE run_id = $1',
      [runId],
    ),
  ])
  const scoresByResult = new Map<string, SampleView['scores']>()
  const scorerIds = new Set<string>()
  for (const s of scores.rows) {
    scorerIds.add(s.scorer_version_id)
    let m = scoresByResult.get(s.case_result_id)
    if (!m) scoresByResult.set(s.case_result_id, (m = {}))
    m[s.scorer_version_id] = { status: s.status, score: s.score, passed: s.passed, confidence: s.confidence, rationale: s.rationale, errorCode: s.error_code }
  }
  const byCase = new Map<string, CaseView>()
  for (const r of cases.rows) {
    let c = byCase.get(r.case_id)
    if (!c) {
      c = { caseId: r.case_id, caseKey: r.case_key, ordinal: r.ordinal, tags: r.tags, input: r.input, reference: r.reference, samples: [], stats: {} }
      byCase.set(r.case_id, c)
    }
    c.samples.push({
      id: r.id,
      sampleIndex: r.sample_index,
      status: r.status,
      attempts: r.attempts,
      output: r.output,
      finishReason: r.finish_reason,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      queueMs: r.queue_ms,
      ttftMs: r.ttft_ms,
      generationMs: r.generation_ms,
      scores: scoresByResult.get(r.id) ?? {},
      annotation: r.label ? { label: r.label, note: r.note ?? '', by: r.annotated_by ?? '', at: r.annotated_at?.toISOString() ?? '' } : null,
    })
  }
  const out = [...byCase.values()]
  for (const svId of scorerIds) {
    const rows = out.flatMap((c) =>
      c.samples.map((s) => {
        const sc = s.scores[svId]
        const scored = sc?.status === 'scored'
        return { caseKey: c.caseKey, sampleIndex: s.sampleIndex, status: s.status, score: scored ? sc.score : null, passed: scored ? sc.passed : null }
      }),
    )
    const stats = new Map(aggregateCases(rows).map((a) => [a.caseKey, a]))
    for (const c of out) {
      const a = stats.get(c.caseKey)
      if (a) c.stats[svId] = { mean: a.mean, variance: a.variance, flaky: a.flaky, scored: a.scored, errored: a.errored }
    }
  }
  return out
}

export async function loadAttempts(db: Queryable, runId: string, caseResultId: string) {
  const { rows } = await db.query<{ attempt: number; worker_id: string; outcome: string; error_code: string | null; http_status: number | null; delay_ms: number | null; started_at: Date; finished_at: Date | null }>(
    `SELECT a.attempt, a.worker_id, a.outcome, a.error_code, a.http_status, a.delay_ms, a.started_at, a.finished_at
       FROM case_attempts a JOIN case_results cr ON cr.id = a.case_result_id
      WHERE a.case_result_id = $1 AND cr.run_id = $2 ORDER BY a.attempt`,
    [caseResultId, runId],
  )
  return rows.map((r) => ({
    attempt: r.attempt,
    workerId: r.worker_id,
    outcome: r.outcome,
    errorCode: r.error_code,
    httpStatus: r.http_status,
    delayMs: r.delay_ms,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  }))
}
