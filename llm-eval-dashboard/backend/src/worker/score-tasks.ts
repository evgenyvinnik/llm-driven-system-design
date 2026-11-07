/**
 * The work queue for score rows: judge scores of fresh outputs, and every
 * re-score. Same claim/lease/fence pattern as generation tasks, keyed
 * (case_result, scorer_version). Scoring reads the STORED output: it never
 * calls the model, which is the whole point of re-scoring.
 * @module worker/score-tasks
 */
import type { Queryable } from '../shared/db.js'
import { newLeaseToken } from '../shared/ids.js'

export interface ClaimedScore {
  caseResultId: string
  scorerVersionId: string
  runId: string
  attempts: number
  leaseToken: string
  kind: string
  config: Record<string, unknown>
  output: string
  reference: string
  input: Record<string, unknown>
  reclaimed: boolean
}

export async function claimScoreTask(db: Queryable, workerId: string, leaseMs: number): Promise<ClaimedScore | null> {
  const token = newLeaseToken()
  const { rows } = await db.query<{
    case_result_id: string
    scorer_version_id: string
    run_id: string
    attempts: number
    prior_status: string
    kind: string
    config: Record<string, unknown>
    output: string | null
    reference: string
    input: Record<string, unknown>
  }>(
    `WITH s AS (
       SELECT sc.case_result_id, sc.scorer_version_id, sc.status AS prior_status
         FROM scores sc
        WHERE (sc.status = 'pending' AND sc.available_at <= now()) OR (sc.status = 'running' AND sc.lease_expires_at <= now())
        ORDER BY sc.available_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE scores sc
          SET status = 'running', attempts = sc.attempts + 1, lease_owner = $1, lease_token = $2,
              lease_expires_at = now() + make_interval(secs => $3::float8 / 1000)
         FROM s
        WHERE sc.case_result_id = s.case_result_id AND sc.scorer_version_id = s.scorer_version_id
       RETURNING sc.case_result_id, sc.scorer_version_id, sc.run_id, sc.attempts, s.prior_status
     )
     SELECT claimed.*, sr.kind, sv.config, cr.output, dc.reference, dc.input
       FROM claimed
       JOIN scorer_versions sv ON sv.id = claimed.scorer_version_id
       JOIN scorers sr ON sr.id = sv.scorer_id
       JOIN case_results cr ON cr.id = claimed.case_result_id
       JOIN dataset_cases dc ON dc.id = cr.case_id`,
    [workerId, token, leaseMs],
  )
  const r = rows[0]
  if (!r) return null
  return {
    caseResultId: r.case_result_id,
    scorerVersionId: r.scorer_version_id,
    runId: r.run_id,
    attempts: r.attempts,
    leaseToken: token,
    kind: r.kind,
    config: r.config,
    output: r.output ?? '',
    reference: r.reference,
    input: r.input,
    reclaimed: r.prior_status === 'running',
  }
}

export type ScoreWrite =
  | { kind: 'scored'; score: number; passed: boolean; rationale: string; confidence?: number }
  | { kind: 'retry'; delayMs: number; errorCode: string; errorMessage: string }
  | { kind: 'errored'; errorCode: string; errorMessage: string }

export async function finishScore(db: Queryable, s: Pick<ClaimedScore, 'caseResultId' | 'scorerVersionId' | 'leaseToken'>, w: ScoreWrite): Promise<boolean> {
  const key = [s.caseResultId, s.scorerVersionId, s.leaseToken]
  const fence = `case_result_id = $1 AND scorer_version_id = $2 AND lease_token = $3 AND status = 'running'`
  const release = `lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL`
  let rowCount: number | null
  if (w.kind === 'scored') {
    ;({ rowCount } = await db.query(
      `UPDATE scores SET status = 'scored', score = $4, passed = $5, rationale = $6, confidence = $7, error_code = NULL, error_message = NULL, scored_at = now(), ${release} WHERE ${fence}`,
      [...key, w.score, w.passed, w.rationale, w.confidence ?? null],
    ))
  } else if (w.kind === 'retry') {
    ;({ rowCount } = await db.query(
      `UPDATE scores SET status = 'pending', available_at = now() + make_interval(secs => $4::float8 / 1000), error_code = $5, error_message = $6, ${release} WHERE ${fence}`,
      [...key, w.delayMs, w.errorCode, w.errorMessage],
    ))
  } else {
    ;({ rowCount } = await db.query(`UPDATE scores SET status = 'errored', error_code = $4, error_message = $5, ${release} WHERE ${fence}`, [...key, w.errorCode, w.errorMessage]))
  }
  return (rowCount ?? 0) > 0
}
