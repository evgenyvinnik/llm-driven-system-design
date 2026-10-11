import type { Pool } from 'pg';
import type { Verdict } from '../services/judge.js';

/**
 * The judge queue is the submissions table itself.
 *
 * Creating a submission and enqueuing its judging job is one INSERT in one transaction, so a
 * submission can never exist without a job (the old code inserted the row and then published
 * to Kafka, and a failed publish left the row 'pending' forever).
 *
 * Lifecycle of a row:
 *   pending --claim--> running --complete--> verdict (accepted, wrong_answer, ...)
 *                         |  \--retry (sandbox failure)--> pending, run_after = now + backoff
 *                         \--lease expires (worker died)--> claimable again by any worker
 *
 * - Claiming uses FOR UPDATE SKIP LOCKED, so many workers can poll at once without blocking on
 *   each other or claiming the same row.
 * - A claim is a lease: lease_expires_at is pushed forward by heartbeats. If a worker dies, the
 *   lease lapses and another worker re-claims the row.
 * - Every claim increments lease_token, a fencing token. Writes from a worker carry the token it
 *   claimed with, so a worker that was presumed dead (lease expired, row re-claimed) cannot
 *   overwrite the verdict of the worker that owns the row now.
 * - judge_attempts counts claims; the worker turns a job that keeps failing into a final
 *   system_error (the dead-letter outcome) instead of retrying forever.
 */

/** NOTIFY channel that wakes idle workers when a submission is created or released. */
export const QUEUE_CHANNEL = 'judge_queue';

/** Anything that can run a query: the pool, or a client inside a transaction. */
type Queryable = Pick<Pool, 'query'>;

export interface ClaimedJob {
  submissionId: string;
  userId: string;
  problemId: string;
  language: string;
  code: string;
  leaseToken: number;
  judgeAttempts: number;
  /** Seconds since the job became eligible to run (creation, or the end of its retry delay). */
  waitSeconds: number;
}

export interface ClaimOptions {
  workerId: string;
  limit: number;
  leaseMs: number;
  /** Restrict this worker to some languages (per-language pools); null claims any language. */
  languages: string[] | null;
}

interface ClaimedRow {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  code: string;
  lease_token: number;
  judge_attempts: number;
  wait_seconds: number;
}

/** Claims up to `limit` jobs: pending rows that are due, and running rows whose lease expired. */
export async function claimJobs(db: Queryable, options: ClaimOptions): Promise<ClaimedJob[]> {
  if (options.limit <= 0) return [];
  const result = await db.query<ClaimedRow>(
    `UPDATE submissions AS s
     SET status = 'running',
         lease_owner = $1,
         lease_expires_at = NOW() + ($2::int * INTERVAL '1 millisecond'),
         lease_token = s.lease_token + 1,
         judge_attempts = s.judge_attempts + 1
     FROM (
       SELECT id FROM submissions
       WHERE ((status = 'pending' AND run_after <= NOW())
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())))
         AND ($4::text[] IS NULL OR language = ANY($4::text[]))
       ORDER BY created_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     ) AS next
     WHERE s.id = next.id
     RETURNING s.id, s.user_id, s.problem_id, s.language, s.code, s.lease_token, s.judge_attempts,
               EXTRACT(EPOCH FROM (NOW() - s.run_after))::float8 AS wait_seconds`,
    [options.workerId, options.leaseMs, options.limit, options.languages]
  );

  return result.rows.map((row) => ({
    submissionId: row.id,
    userId: row.user_id,
    problemId: row.problem_id,
    language: row.language,
    code: row.code,
    leaseToken: row.lease_token,
    judgeAttempts: row.judge_attempts,
    waitSeconds: Math.max(0, row.wait_seconds)
  }));
}

/** Heartbeat: pushes the lease forward. False means another worker owns the job now. */
export async function extendLease(db: Queryable, job: ClaimedJob, leaseMs: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE submissions
     SET lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond')
     WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.submissionId, job.leaseToken, leaseMs]
  );
  return result.rowCount === 1;
}

/**
 * Records the verdict and the user's progress in one transaction, fenced by the lease token.
 * Returns false (and writes nothing) when the lease was lost.
 */
export async function completeJob(pool: Pool, job: ClaimedJob, verdict: Verdict): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ user_id: string; problem_id: string }>(
      `UPDATE submissions
       SET status = $3,
           runtime_ms = $4,
           memory_kb = $5,
           test_cases_passed = $6,
           test_cases_total = $7,
           error_message = $8,
           judged_at = NOW(),
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2 AND status = 'running'
       RETURNING user_id, problem_id`,
      [
        job.submissionId,
        job.leaseToken,
        verdict.status,
        verdict.runtimeMs,
        verdict.memoryKb,
        verdict.testCasesPassed,
        verdict.testCasesTotal,
        verdict.errorMessage
      ]
    );

    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }

    if (verdict.status === 'accepted') {
      // Attempts were counted when the submission was created; only the solve is recorded here.
      await client.query(
        `INSERT INTO user_problem_status (user_id, problem_id, status, best_runtime_ms, attempts, solved_at)
         VALUES ($1, $2, 'solved', $3, 1, NOW())
         ON CONFLICT (user_id, problem_id) DO UPDATE SET
           status = 'solved',
           best_runtime_ms = LEAST(user_problem_status.best_runtime_ms, EXCLUDED.best_runtime_ms),
           solved_at = COALESCE(user_problem_status.solved_at, EXCLUDED.solved_at)`,
        [job.userId, job.problemId, verdict.runtimeMs]
      );
    }

    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Puts a job back in the queue after a sandbox failure, to be retried after `delayMs`. */
export async function retryJob(db: Queryable, job: ClaimedJob, delayMs: number, reason: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE submissions
     SET status = 'pending',
         run_after = NOW() + ($3::int * INTERVAL '1 millisecond'),
         lease_owner = NULL,
         lease_expires_at = NULL,
         error_message = $4
     WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.submissionId, job.leaseToken, Math.round(delayMs), reason]
  );
  return result.rowCount === 1;
}

/** Hands a job back immediately (graceful shutdown); the interrupted attempt is not counted. */
export async function releaseJob(db: Queryable, job: ClaimedJob): Promise<boolean> {
  const result = await db.query(
    `UPDATE submissions
     SET status = 'pending',
         run_after = NOW(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         judge_attempts = GREATEST(judge_attempts - 1, 0)
     WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [job.submissionId, job.leaseToken]
  );
  if (result.rowCount === 1) {
    await db.query('SELECT pg_notify($1, $2)', [QUEUE_CHANNEL, job.submissionId]);
    return true;
  }
  return false;
}

/** Number of submissions waiting for a worker (the queue depth gauge). */
export async function countPending(db: Queryable): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM submissions WHERE status = 'pending'`
  );
  return parseInt(result.rows[0].count, 10);
}
