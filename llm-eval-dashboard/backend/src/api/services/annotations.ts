/**
 * Human annotation for one run: the review queue, labels, and judge-vs-human
 * agreement.
 *
 * The queue holds outputs worth a human look:
 * - low_confidence: a model-graded score with confidence < 0.5;
 * - samples_disagree: the case's samples disagree on pass/fail under the
 *   run's first automated scorer (the model is unstable there);
 * - spot_check: a stable ~1-in-8 random slice of everything else, so the
 *   agreement estimate isn't biased toward hard items.
 * A label also writes a score row for every human scorer version on the run.
 * @module api/services/annotations
 */
import { z } from 'zod'
import { agreement, isSpotCheck, type Agreement } from '../../shared/agreement.js'
import { withTransaction, type Queryable } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { loadCaseTable } from './cases.js'

export const annotationSchema = z.object({ label: z.enum(['pass', 'fail']), note: z.string().max(2000).default('') }).strict()

export type QueueReason = 'low_confidence' | 'samples_disagree' | 'spot_check'

export interface QueueItem {
  caseResultId: string
  caseKey: string
  sampleIndex: number
  input: Record<string, unknown>
  reference: string
  output: string
  reasons: QueueReason[]
  judge: { scorerVersionId: string; name: string; version: number; score: number | null; passed: boolean | null; confidence: number | null; rationale: string | null }[]
  primary: { scorerVersionId: string; passed: boolean | null } | null
  annotation: { label: 'pass' | 'fail'; note: string; by: string; at: string } | null
}

export interface AgreementRow {
  scorerVersionId: string
  name: string
  version: number
  overall: Agreement
  spotCheck: Agreement
  queue: Agreement
}

export async function annotationQueue(db: Queryable, workspaceId: string, runId: string): Promise<{ items: QueueItem[]; agreement: AgreementRow[]; labeled: number; total: number }> {
  const run = await db.query('SELECT 1 FROM eval_runs WHERE id = $1 AND workspace_id = $2', [runId, workspaceId])
  if (!run.rows[0]) throw notFound('Run')
  const scorers = await db.query<{ id: string; name: string; kind: string; version: number }>(
    `SELECT sv.id, s.name, s.kind, sv.version FROM run_scorers rs JOIN scorer_versions sv ON sv.id = rs.scorer_version_id JOIN scorers s ON s.id = sv.scorer_id
      WHERE rs.run_id = $1 ORDER BY rs.origin, rs.added_at, sv.version`,
    [runId],
  )
  const judges = scorers.rows.filter((s) => s.kind === 'model_graded')
  const primary = scorers.rows.find((s) => s.kind !== 'human') ?? null
  const cases = await loadCaseTable(db, runId)

  const items: QueueItem[] = []
  for (const c of cases) {
    const passes = primary ? c.samples.filter((s) => s.status === 'succeeded').map((s) => s.scores[primary.id]?.passed).filter((p): p is boolean => typeof p === 'boolean') : []
    const disagree = passes.length > 1 && passes.some((p) => p !== passes[0])
    for (const s of c.samples) {
      if (s.status !== 'succeeded') continue
      const reasons: QueueReason[] = []
      const judgeScores = judges.map((j) => {
        const sc = s.scores[j.id]
        return { scorerVersionId: j.id, name: j.name, version: j.version, score: sc?.score ?? null, passed: sc?.passed ?? null, confidence: sc?.confidence ?? null, rationale: sc?.rationale ?? null }
      })
      if (judgeScores.some((j) => j.confidence !== null && j.confidence < 0.5)) reasons.push('low_confidence')
      if (disagree) reasons.push('samples_disagree')
      if (reasons.length === 0 && isSpotCheck(s.id)) reasons.push('spot_check')
      if (reasons.length === 0 && !s.annotation) continue
      items.push({
        caseResultId: s.id,
        caseKey: c.caseKey,
        sampleIndex: s.sampleIndex,
        input: c.input,
        reference: c.reference,
        output: s.output ?? '',
        reasons,
        judge: judgeScores,
        primary: primary ? { scorerVersionId: primary.id, passed: s.scores[primary.id]?.passed ?? null } : null,
        annotation: s.annotation,
      })
    }
  }
  // Unlabeled first, then by reason (low confidence is the most informative).
  const rank = (i: QueueItem) => (i.annotation ? 10 : 0) + (i.reasons.includes('low_confidence') ? 0 : i.reasons.includes('samples_disagree') ? 1 : 2)
  items.sort((x, y) => rank(x) - rank(y) || x.caseKey.localeCompare(y.caseKey) || x.sampleIndex - y.sampleIndex)

  const agreementRows: AgreementRow[] = judges.map((j) => {
    const pairsFor = (filter: (i: QueueItem) => boolean) =>
      items
        .filter((i) => i.annotation && filter(i))
        .map((i) => ({ judgePassed: i.judge.find((x) => x.scorerVersionId === j.id)?.passed, humanPassed: i.annotation!.label === 'pass' }))
        .filter((p): p is { judgePassed: boolean; humanPassed: boolean } => typeof p.judgePassed === 'boolean')
    return {
      scorerVersionId: j.id,
      name: j.name,
      version: j.version,
      overall: agreement(pairsFor(() => true)),
      spotCheck: agreement(pairsFor((i) => i.reasons.length === 1 && i.reasons[0] === 'spot_check')),
      queue: agreement(pairsFor((i) => i.reasons.some((r) => r !== 'spot_check'))),
    }
  })
  return { items, agreement: agreementRows, labeled: items.filter((i) => i.annotation).length, total: items.length }
}

export async function saveAnnotation(workspaceId: string, userId: string, runId: string, caseResultId: string, input: z.infer<typeof annotationSchema>) {
  return withTransaction(async (client) => {
    const cr = await client.query<{ status: string }>(
      'SELECT cr.status FROM case_results cr JOIN eval_runs r ON r.id = cr.run_id WHERE cr.id = $1 AND cr.run_id = $2 AND r.workspace_id = $3',
      [caseResultId, runId, workspaceId],
    )
    if (!cr.rows[0]) throw notFound('Case result')
    if (cr.rows[0].status !== 'succeeded') throw new HttpError(422, 'NO_OUTPUT', 'Only outputs that were generated can be labeled')
    await client.query(
      `INSERT INTO annotations (case_result_id, run_id, label, note, annotated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (case_result_id) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, annotated_by = EXCLUDED.annotated_by, updated_at = now()`,
      [caseResultId, runId, input.label, input.note, userId],
    )
    const humans = await client.query(
      `INSERT INTO scores (case_result_id, scorer_version_id, run_id, status, score, passed, rationale, scored_at)
       SELECT $1, rs.scorer_version_id, $2, 'scored', $3, $4, $5, now()
         FROM run_scorers rs JOIN scorer_versions sv ON sv.id = rs.scorer_version_id JOIN scorers s ON s.id = sv.scorer_id
        WHERE rs.run_id = $2 AND s.kind = 'human'
       ON CONFLICT (case_result_id, scorer_version_id) DO UPDATE SET score = EXCLUDED.score, passed = EXCLUDED.passed, rationale = EXCLUDED.rationale, scored_at = now(), status = 'scored'`,
      [caseResultId, runId, input.label === 'pass' ? 1 : 0, input.label === 'pass', input.note || `labeled ${input.label}`],
    )
    return { caseResultId, label: input.label, humanScoresWritten: humans.rowCount ?? 0 }
  })
}
