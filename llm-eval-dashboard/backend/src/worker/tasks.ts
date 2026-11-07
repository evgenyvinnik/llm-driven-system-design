/**
 * The PostgreSQL work queue for generation tasks (case_results rows).
 *
 * Claim, in one transaction:
 *   1. Lock one runnable run with FOR NO KEY UPDATE SKIP LOCKED, least
 *      recently served first (round robin = fairness between runs). Concurrent
 *      claimers skip it and serve other runs.
 *   2. In a fresh statement (READ COMMITTED: sees every committed claim),
 *      count the run's live leases and claim one task only if under the run's
 *      concurrency limit. A task is claimable when pending and due, or running
 *      with an expired lease (its worker died).
 *   3. Record the attempt; a re-claimed lease marks the previous attempt
 *      `lease_expired`.
 * Every later write is fenced by the lease token, so a worker that lost its
 * lease (stalled, or presumed dead) can't overwrite the new owner's result.
 * Run state changes never happen in the same transaction as a task write
 * (lock order: run row → task rows only), so cancel can't deadlock a worker.
 * @module worker/tasks
 */
import type pg from 'pg'
import type { Queryable } from '../shared/db.js'
import { newLeaseToken } from '../shared/ids.js'

export interface ClaimedTask {
  id: string
  runId: string
  caseId: string
  caseKey: string
  sampleIndex: number
  attempt: number
  roundAttempts: number
  leaseToken: string
  queueMs: number
  reclaimed: boolean
}

const CLAIMABLE = `((c.status = 'pending' AND c.available_at <= now()) OR (c.status = 'running' AND c.lease_expires_at <= now()))`

export async function claimGenerationTask(client: pg.PoolClient, workerId: string, leaseMs: number): Promise<ClaimedTask | null> {
  const tried: string[] = []
  for (let i = 0; i < 4; i++) {
    await client.query('BEGIN')
    try {
      const run = await client.query<{ id: string; concurrency_limit: number }>(
        `SELECT r.id, r.concurrency_limit
           FROM eval_runs r
          WHERE r.status IN ('queued', 'running')
            AND NOT (r.id = ANY($1::text[]))
            AND EXISTS (SELECT 1 FROM case_results c WHERE c.run_id = r.id AND ${CLAIMABLE})
            AND (SELECT count(*) FROM case_results c WHERE c.run_id = r.id AND c.status = 'running' AND c.lease_expires_at > now()) < r.concurrency_limit
          ORDER BY r.last_claimed_at NULLS FIRST, r.created_at
          LIMIT 1
          FOR NO KEY UPDATE OF r SKIP LOCKED`,
        [tried],
      )
      const target = run.rows[0]
      if (!target) {
        // Nothing unlocked. If a runnable run exists but another claimer holds
        // its row right now, wait a few ms and try again rather than idling.
        const busy = await client.query(
          `SELECT 1 FROM eval_runs r WHERE r.status IN ('queued', 'running') AND NOT (r.id = ANY($1::text[]))
              AND EXISTS (SELECT 1 FROM case_results c WHERE c.run_id = r.id AND ${CLAIMABLE})
              AND (SELECT count(*) FROM case_results c WHERE c.run_id = r.id AND c.status = 'running' AND c.lease_expires_at > now()) < r.concurrency_limit
            LIMIT 1`,
          [tried],
        )
        await client.query('COMMIT')
        if (busy.rows.length === 0 || i === 3) return null
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20))
        continue
      }
      const token = newLeaseToken()
      const claimed = await client.query<{
        id: string
        case_id: string
        case_key: string
        sample_index: number
        attempts: number
        round_attempts: number
        queue_ms: number
        prior_status: string
      }>(
        `WITH task AS (
           SELECT c.id, c.status AS prior_status
             FROM case_results c
            WHERE c.run_id = $1 AND ${CLAIMABLE}
              AND (SELECT count(*) FROM case_results l WHERE l.run_id = $1 AND l.status = 'running' AND l.lease_expires_at > now()) < $2
            ORDER BY c.available_at, c.sample_index, c.case_key
            LIMIT 1
            FOR UPDATE OF c SKIP LOCKED
         )
         UPDATE case_results c
            SET status = 'running', attempts = c.attempts + 1, round_attempts = c.round_attempts + 1,
                lease_owner = $3, lease_token = $4, lease_expires_at = now() + make_interval(secs => $5::float8 / 1000),
                started_at = COALESCE(c.started_at, now()),
                queue_ms = GREATEST(0, (EXTRACT(EPOCH FROM (now() - c.available_at)) * 1000)::int)
           FROM task
          WHERE c.id = task.id
         RETURNING c.id, c.case_id, c.case_key, c.sample_index, c.attempts, c.round_attempts, c.queue_ms, task.prior_status`,
        [target.id, target.concurrency_limit, workerId, token, leaseMs],
      )
      const row = claimed.rows[0]
      if (!row) {
        await client.query('COMMIT')
        tried.push(target.id)
        continue
      }
      await client.query(
        `UPDATE eval_runs SET last_claimed_at = clock_timestamp(), started_at = COALESCE(started_at, now()),
                status = CASE WHEN status = 'queued' THEN 'running' ELSE status END
          WHERE id = $1`,
        [target.id],
      )
      const reclaimed = row.prior_status === 'running'
      if (reclaimed) {
        await client.query(`UPDATE case_attempts SET outcome = 'lease_expired', finished_at = now() WHERE case_result_id = $1 AND outcome = 'in_progress'`, [row.id])
      }
      await client.query(`INSERT INTO case_attempts (case_result_id, attempt, worker_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [row.id, row.attempts, workerId])
      await client.query('COMMIT')
      return {
        id: row.id,
        runId: target.id,
        caseId: row.case_id,
        caseKey: row.case_key,
        sampleIndex: row.sample_index,
        attempt: row.attempts,
        roundAttempts: row.round_attempts,
        leaseToken: token,
        queueMs: row.queue_ms,
        reclaimed,
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  }
  return null
}

/** Extends the lease; false means it was lost (expired and re-claimed) or the task is no longer running. */
export async function heartbeat(db: Queryable, taskId: string, token: string, leaseMs: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE case_results SET lease_expires_at = now() + make_interval(secs => $3::float8 / 1000)
      WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [taskId, token, leaseMs],
  )
  return (rowCount ?? 0) > 0
}

export interface SuccessWrite {
  output: string
  finishReason: string
  inputTokens: number
  outputTokens: number
  ttftMs: number
  generationMs: number
}

export interface InlineScore {
  scorerVersionId: string
  status: 'scored' | 'pending'
  score?: number
  passed?: boolean
  rationale?: string
}

/**
 * Records a successful generation and its inline scores in one transaction.
 * Returns false (and writes nothing) when the lease was lost.
 */
export async function completeTask(client: pg.PoolClient, task: Pick<ClaimedTask, 'id' | 'runId' | 'attempt' | 'leaseToken'>, out: SuccessWrite, scores: InlineScore[]): Promise<boolean> {
  await client.query('BEGIN')
  try {
    const updated = await client.query(
      `UPDATE case_results
          SET status = 'succeeded', output = $3, finish_reason = $4, input_tokens = $5, output_tokens = $6, ttft_ms = $7, generation_ms = $8,
              error_code = NULL, error_message = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, finished_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [task.id, task.leaseToken, out.output, out.finishReason, out.inputTokens, out.outputTokens, out.ttftMs, out.generationMs],
    )
    if ((updated.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query(`UPDATE case_attempts SET outcome = 'succeeded', finished_at = now() WHERE case_result_id = $1 AND attempt = $2`, [task.id, task.attempt])
    for (const s of scores) {
      await client.query(
        `INSERT INTO scores (case_result_id, scorer_version_id, run_id, status, score, passed, rationale, scored_at)
         VALUES ($1, $2, $3,
                 CASE WHEN $4 = 'pending' AND (SELECT status FROM eval_runs WHERE id = $3) = 'cancelled' THEN 'cancelled' ELSE $4 END,
                 $5, $6, $7, CASE WHEN $4 = 'scored' THEN now() END)
         ON CONFLICT (case_result_id, scorer_version_id) DO NOTHING`,
        [task.id, s.scorerVersionId, task.runId, s.status, s.score ?? null, s.passed ?? null, s.rationale ?? null],
      )
    }
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  }
}

export type FailureWrite =
  | { kind: 'retry'; delayMs: number; errorCode: string; errorMessage: string; httpStatus?: number }
  | { kind: 'errored'; errorCode: string; errorMessage: string; httpStatus?: number }
  | { kind: 'cancelled'; partial: string }

/** Fenced write for a failed or cancelled attempt. Returns false when the lease was lost. */
export async function failTask(db: Queryable, task: Pick<ClaimedTask, 'id' | 'attempt' | 'leaseToken'>, f: FailureWrite): Promise<boolean> {
  let result: pg.QueryResult
  if (f.kind === 'retry') {
    result = await db.query(
      `UPDATE case_results SET status = 'pending', available_at = now() + make_interval(secs => $3::float8 / 1000),
              error_code = $4, error_message = $5, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [task.id, task.leaseToken, f.delayMs, f.errorCode, f.errorMessage],
    )
  } else if (f.kind === 'errored') {
    result = await db.query(
      `UPDATE case_results SET status = 'errored', error_code = $3, error_message = $4, finished_at = now(),
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [task.id, task.leaseToken, f.errorCode, f.errorMessage],
    )
  } else {
    result = await db.query(
      `UPDATE case_results SET status = 'cancelled', output = NULLIF($3, ''), finish_reason = 'cancelled', finished_at = now(),
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
      [task.id, task.leaseToken, f.partial],
    )
  }
  const ok = (result.rowCount ?? 0) > 0
  const outcome = !ok ? 'superseded' : f.kind === 'retry' ? 'retry_scheduled' : f.kind
  await db.query(
    `UPDATE case_attempts SET outcome = $3, error_code = $4, http_status = $5, delay_ms = $6, finished_at = now()
      WHERE case_result_id = $1 AND attempt = $2 AND outcome = 'in_progress'`,
    [task.id, task.attempt, outcome, f.kind === 'cancelled' ? null : f.errorCode, f.kind === 'cancelled' ? null : (f.httpStatus ?? null), f.kind === 'retry' ? Math.round(f.delayMs) : null],
  )
  return ok
}

/** Marks an attempt superseded after a lost lease (the new owner's result stands). */
export async function markSuperseded(db: Queryable, taskId: string, attempt: number): Promise<void> {
  await db.query(`UPDATE case_attempts SET outcome = 'superseded', finished_at = now() WHERE case_result_id = $1 AND attempt = $2 AND outcome = 'in_progress'`, [taskId, attempt])
}

/**
 * Moves a running run to completed (≥ 1 success) or failed (nothing
 * succeeded) once no task or score is pending or running. Safe to call from
 * many workers at once: the status guard lets exactly one transition win.
 */
export async function finalizeRun(db: Queryable, runId: string): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(
    `UPDATE eval_runs r
        SET status = CASE WHEN EXISTS (SELECT 1 FROM case_results c WHERE c.run_id = r.id AND c.status = 'succeeded') THEN 'completed' ELSE 'failed' END,
            failure_reason = CASE WHEN EXISTS (SELECT 1 FROM case_results c WHERE c.run_id = r.id AND c.status = 'succeeded') THEN NULL
                             ELSE (SELECT 'every task errored; most common: ' || error_code FROM case_results c WHERE c.run_id = r.id AND c.status = 'errored'
                                    GROUP BY error_code ORDER BY count(*) DESC LIMIT 1) END,
            finished_at = now()
      WHERE r.id = $1 AND r.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM case_results c WHERE c.run_id = r.id AND c.status IN ('pending', 'running'))
        AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id AND s.status IN ('pending', 'running'))
      RETURNING r.status`,
    [runId],
  )
  return rows[0]?.status ?? null
}
