/**
 * PostgreSQL-backed execution queue: claiming, leases, fencing, retries and the reaper.
 *
 * `job_executions` is both the attempt history and the work queue, so there is no
 * second system to keep in sync. The life of one attempt:
 *
 *   PENDING --claim (SKIP LOCKED, new fencing token, lease)--> RUNNING
 *   RUNNING --fenced complete--> COMPLETED
 *   RUNNING --fenced fail, retries left--> FAILED  (+ new PENDING row, attempt + 1, run_at = now + backoff)
 *   RUNNING --fenced fail, none left / non-retryable--> DEAD_LETTER
 *   RUNNING --lease lapses, reaper--> same as a retryable failure
 *   RUNNING --fenced release (breaker open, shutdown)--> PENDING (attempt not consumed)
 *   PENDING | RUNNING --cancel--> CANCELLED
 *
 * Every write a worker makes after claiming carries `fencing_token = $token AND
 * status = 'RUNNING'`. If the reaper or a cancel got there first, the write matches
 * zero rows and the worker learns it no longer owns the attempt.
 * @module db/execution-queue
 */

import { PoolClient } from 'pg';
import { query, withTransaction } from './pool';
import { JobExecution, ExecutionStatus } from '../types/index';
import { computeBackoffMs, shouldRetry } from '../shared/backoff';

/** A RUNNING execution as returned to the worker that claimed it. */
export interface ClaimedExecution extends JobExecution {
  fencing_token: string;
}

/** Identifies one lease: the execution plus the token issued when it was claimed. */
export interface LeaseRef {
  executionId: string;
  fencingToken: string;
}

/** What happened to an attempt that failed (or whose lease lapsed). */
export type FailureOutcome =
  | { outcome: 'retry'; nextAttempt: number; runAt: Date }
  | { outcome: 'dead_letter' };

/** Longest error text stored per attempt; webhook errors can embed whole response bodies. */
const MAX_ERROR_LENGTH = 2000;

/** Slots tried for one manual run before giving up (collisions need equal NOW() values). */
const MAX_SLOT_ATTEMPTS = 10;

/**
 * Claims up to `limit` runnable executions for `workerId`.
 *
 * One statement: the CTE picks PENDING rows whose run_at has arrived, highest
 * priority first, and locks them with FOR UPDATE SKIP LOCKED, so concurrent workers
 * skip rows another worker is claiming instead of blocking on them or claiming them
 * twice. The UPDATE then marks them RUNNING with a lease and a fresh fencing token.
 * Executions of paused jobs are held until the job is resumed.
 */
export async function claimExecutions(
  workerId: string,
  limit: number,
  leaseMs: number
): Promise<ClaimedExecution[]> {
  if (limit <= 0) {
    return [];
  }

  const claimed = await query<ClaimedExecution>(
    `WITH next AS (
       SELECT e.id
       FROM job_executions e
       WHERE e.status = 'PENDING'
         AND e.run_at <= NOW()
         AND NOT EXISTS (
           SELECT 1 FROM jobs j WHERE j.id = e.job_id AND j.status = 'PAUSED'
         )
       ORDER BY e.priority DESC, e.run_at ASC
       LIMIT $2
       FOR UPDATE OF e SKIP LOCKED
     )
     UPDATE job_executions e
     SET status = 'RUNNING',
         worker_id = $1,
         started_at = NOW(),
         completed_at = NULL,
         lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
         fencing_token = nextval('execution_fencing_seq')
     FROM next
     WHERE e.id = next.id
     RETURNING e.*`,
    [workerId, limit, leaseMs]
  );

  if (claimed.length > 0) {
    // One-time jobs mirror their single run in jobs.status; recurring jobs stay SCHEDULED.
    await query(
      `UPDATE jobs SET status = 'RUNNING'
       WHERE id = ANY($1::uuid[]) AND schedule IS NULL AND status = 'QUEUED'`,
      [claimed.map((execution) => execution.job_id)]
    );
  }

  return claimed;
}

/**
 * Extends the leases this worker still holds, in one round trip.
 * @returns ids of executions whose lease was extended; any id missing from the set was
 *   cancelled or reclaimed by the reaper, and its handler must stop.
 */
export async function renewLeases(leases: LeaseRef[], leaseMs: number): Promise<Set<string>> {
  if (leases.length === 0) {
    return new Set();
  }

  const renewed = await query<{ id: string }>(
    `UPDATE job_executions e
     SET lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond')
     FROM unnest($1::uuid[], $2::bigint[]) AS held(id, token)
     WHERE e.id = held.id
       AND e.fencing_token = held.token
       AND e.status = 'RUNNING'
     RETURNING e.id`,
    [leases.map((lease) => lease.executionId), leases.map((lease) => lease.fencingToken), leaseMs]
  );

  return new Set(renewed.map((row) => row.id));
}

/**
 * Records a successful attempt, if the caller still owns it.
 * @returns false when the lease was lost (the result must be discarded)
 */
export async function completeExecution(
  lease: LeaseRef,
  result: unknown
): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ job_id: string }>(
      `UPDATE job_executions
       SET status = 'COMPLETED', completed_at = NOW(), result = $3, lease_expires_at = NULL
       WHERE id = $1 AND fencing_token = $2 AND status = 'RUNNING'
       RETURNING job_id`,
      [lease.executionId, lease.fencingToken, JSON.stringify(result ?? null)]
    );
    if (rows.length === 0) {
      return false;
    }

    await setOneTimeJobStatus(client, rows[0].job_id, ['QUEUED', 'RUNNING'], 'COMPLETED');
    return true;
  });
}

/** Execution row joined with the job's retry policy, as needed by applyFailure. */
interface FailureRow extends JobExecution {
  max_retries: number;
  initial_backoff_ms: number;
  max_backoff_ms: number;
  schedule: string | null;
}

/**
 * Records a failed attempt, if the caller still owns it, and schedules the retry or
 * dead-letters the run. The attempt row and its retry are written in one transaction.
 *
 * @param retryable - false for deterministic failures (unknown handler, invalid payload)
 *   that would fail the same way on every retry
 * @returns the outcome, or null when the lease was lost
 */
export async function failExecution(
  lease: LeaseRef,
  errorMessage: string,
  retryable: boolean
): Promise<FailureOutcome | null> {
  return withTransaction(async (client) => {
    // No SKIP LOCKED: if the reaper holds this row we wait for it, then the WHERE is
    // re-checked against the reaper's committed version and matches nothing.
    const { rows } = await client.query<FailureRow>(
      `SELECT e.*, j.max_retries, j.initial_backoff_ms, j.max_backoff_ms, j.schedule
       FROM job_executions e
       JOIN jobs j ON j.id = e.job_id
       WHERE e.id = $1 AND e.fencing_token = $2 AND e.status = 'RUNNING'
       FOR UPDATE OF e`,
      [lease.executionId, lease.fencingToken]
    );
    if (rows.length === 0) {
      return null;
    }

    return applyFailure(client, rows[0], errorMessage, retryable);
  });
}

/**
 * Returns a claimed execution to the queue without consuming an attempt, if the caller
 * still owns it. Used when the handler never ran (its circuit breaker is open) and on
 * graceful shutdown, so the work is picked up again without waiting for the lease.
 * @param delayMs - how long before the execution becomes claimable again
 */
export async function releaseExecution(lease: LeaseRef, delayMs: number): Promise<boolean> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ job_id: string }>(
      `UPDATE job_executions
       SET status = 'PENDING', worker_id = NULL, started_at = NULL, lease_expires_at = NULL,
           run_at = NOW() + ($3::int * INTERVAL '1 millisecond')
       WHERE id = $1 AND fencing_token = $2 AND status = 'RUNNING'
       RETURNING job_id`,
      [lease.executionId, lease.fencingToken, delayMs]
    );
    if (rows.length === 0) {
      return false;
    }

    await setOneTimeJobStatus(client, rows[0].job_id, ['RUNNING'], 'QUEUED');
    return true;
  });
}

/** One lease the reaper reclaimed. */
export interface ReapedLease {
  executionId: string;
  jobId: string;
  workerId: string | null;
  outcome: FailureOutcome;
}

/**
 * Reclaims executions whose worker stopped renewing its lease (crashed, partitioned,
 * or stalled longer than the lease). A lapsed lease counts as a failed attempt, so a
 * job that crashes its worker every time is dead-lettered after max_retries instead of
 * cycling forever. Safe to run from several processes at once: rows are locked with
 * SKIP LOCKED, and each one is handled in the same transaction that locked it.
 * RUNNING rows with no lease at all predate leases (seed data) and are reaped too.
 */
export async function reapExpiredLeases(limit: number): Promise<ReapedLease[]> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<FailureRow>(
      `SELECT e.*, j.max_retries, j.initial_backoff_ms, j.max_backoff_ms, j.schedule
       FROM job_executions e
       JOIN jobs j ON j.id = e.job_id
       WHERE e.status = 'RUNNING'
         AND (e.lease_expires_at IS NULL OR e.lease_expires_at < NOW())
       ORDER BY e.lease_expires_at ASC NULLS FIRST
       LIMIT $1
       FOR UPDATE OF e SKIP LOCKED`,
      [limit]
    );

    const reaped: ReapedLease[] = [];
    for (const row of rows) {
      const message =
        `Lease expired: worker ${row.worker_id ?? 'unknown'} stopped renewing ` +
        `(fencing token ${row.fencing_token ?? 'none'})`;
      const outcome = await applyFailure(client, row, message, true);
      reaped.push({ executionId: row.id, jobId: row.job_id, workerId: row.worker_id, outcome });
    }
    return reaped;
  });
}

/**
 * Closes a failed attempt and either inserts the next attempt or dead-letters the run.
 * The caller must hold the row lock (it was selected FOR UPDATE in this transaction).
 */
async function applyFailure(
  client: PoolClient,
  row: FailureRow,
  errorMessage: string,
  retryable: boolean
): Promise<FailureOutcome> {
  const error = errorMessage.slice(0, MAX_ERROR_LENGTH);

  if (retryable && shouldRetry(row.attempt, row.max_retries)) {
    const delayMs = computeBackoffMs(row.attempt, row.initial_backoff_ms, row.max_backoff_ms);
    const { rows: closed } = await client.query<{ next_retry_at: Date }>(
      `UPDATE job_executions
       SET status = 'FAILED', completed_at = NOW(), error = $2, lease_expires_at = NULL,
           next_retry_at = NOW() + ($3::int * INTERVAL '1 millisecond')
       WHERE id = $1
       RETURNING next_retry_at`,
      [row.id, error, delayMs]
    );
    const runAt = closed[0].next_retry_at;

    // Same logical run (job, scheduled slot), next attempt number. The slot is copied
    // inside SQL: a JS Date would drop PostgreSQL's microseconds and detach the retry
    // from its run. The unique index on (job_id, scheduled_at, attempt) makes a
    // duplicate retry insert a no-op.
    await client.query(
      `INSERT INTO job_executions (job_id, status, attempt, scheduled_at, run_at, priority)
       SELECT job_id, 'PENDING', attempt + 1, scheduled_at, $2, priority
       FROM job_executions WHERE id = $1
       ON CONFLICT (job_id, scheduled_at, attempt) DO NOTHING`,
      [row.id, runAt]
    );
    await setOneTimeJobStatus(client, row.job_id, ['RUNNING'], 'QUEUED');
    return { outcome: 'retry', nextAttempt: row.attempt + 1, runAt };
  }

  await client.query(
    `UPDATE job_executions
     SET status = 'DEAD_LETTER', completed_at = NOW(), error = $2,
         lease_expires_at = NULL, next_retry_at = NULL
     WHERE id = $1`,
    [row.id, error]
  );
  await setOneTimeJobStatus(client, row.job_id, ['QUEUED', 'RUNNING'], 'FAILED');
  return { outcome: 'dead_letter' };
}

/**
 * Moves a one-time job's status only if it is still in one of `from` (compare-and-set).
 * Recurring jobs are left alone, and a PAUSED job is never overwritten, which is what
 * lets a pause survive an execution that finishes after it.
 */
async function setOneTimeJobStatus(
  client: PoolClient,
  jobId: string,
  from: string[],
  to: string
): Promise<void> {
  await client.query(
    `UPDATE jobs SET status = $3
     WHERE id = $1 AND schedule IS NULL AND status = ANY($2::text[])`,
    [jobId, from, to]
  );
}

/**
 * Enqueues an on-demand run of a job (the "Trigger now" button). The run gets its own
 * slot (scheduled_at = now), so it never collides with a scheduled firing.
 */
export async function enqueueManualRun(jobId: string, priority: number): Promise<JobExecution> {
  return withTransaction(async (client) => {
    // Every run needs its own slot, or two runs' retry chains would collide on the
    // (job_id, scheduled_at, attempt) index. Two triggers whose transactions start in the
    // same microsecond would share NOW(), so on a conflict move one microsecond on.
    for (let offset = 0; offset < MAX_SLOT_ATTEMPTS; offset++) {
      const { rows } = await client.query<JobExecution>(
        `INSERT INTO job_executions (job_id, status, attempt, scheduled_at, run_at, priority)
         VALUES ($1, 'PENDING', 1, NOW() + ($3::int * INTERVAL '1 microsecond'), NOW(), $2)
         ON CONFLICT (job_id, scheduled_at, attempt) DO NOTHING
         RETURNING *`,
        [jobId, priority, offset]
      );
      if (rows.length > 0) {
        await setOneTimeJobStatus(client, jobId, ['SCHEDULED', 'COMPLETED', 'FAILED'], 'QUEUED');
        return rows[0];
      }
    }
    throw new Error(`Could not allocate a unique slot for a manual run of job ${jobId}`);
  });
}

/** Result of asking to run a finished execution again. */
export type RedriveResult =
  | { ok: true; execution: JobExecution }
  | { ok: false; reason: 'not_found' | 'not_retryable' | 'superseded' };

/**
 * Runs a failed, cancelled or dead-lettered run again as its next attempt (same job and
 * slot, attempt + 1), and takes a dead-lettered row out of the dead-letter state.
 *
 * Only the latest attempt of a run can be redriven, and the row is locked while we
 * decide, so a double-clicked Retry produces one new attempt: the second request finds
 * a newer attempt and gets `superseded`.
 */
export async function redriveExecution(executionId: string): Promise<RedriveResult> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<JobExecution>(
      'SELECT * FROM job_executions WHERE id = $1 FOR UPDATE',
      [executionId]
    );
    if (rows.length === 0) {
      return { ok: false, reason: 'not_found' };
    }

    const execution = rows[0];
    const retryableStates: string[] = [
      ExecutionStatus.FAILED,
      ExecutionStatus.CANCELLED,
      ExecutionStatus.DEAD_LETTER,
    ];
    if (!retryableStates.includes(execution.status)) {
      return { ok: false, reason: 'not_retryable' };
    }

    // Compare slots inside SQL; see applyFailure for why scheduled_at never round-trips
    // through JavaScript.
    const { rows: latest } = await client.query<{ max_attempt: number }>(
      `SELECT MAX(m.attempt) AS max_attempt
       FROM job_executions e
       JOIN job_executions m ON m.job_id = e.job_id AND m.scheduled_at = e.scheduled_at
       WHERE e.id = $1`,
      [executionId]
    );
    if (latest[0].max_attempt !== execution.attempt) {
      return { ok: false, reason: 'superseded' };
    }

    const { rows: inserted } = await client.query<JobExecution>(
      `INSERT INTO job_executions (job_id, status, attempt, scheduled_at, run_at, priority)
       SELECT job_id, 'PENDING', attempt + 1, scheduled_at, NOW(), priority
       FROM job_executions WHERE id = $1
       ON CONFLICT (job_id, scheduled_at, attempt) DO NOTHING
       RETURNING *`,
      [executionId]
    );
    if (inserted.length === 0) {
      return { ok: false, reason: 'superseded' };
    }

    if (execution.status === ExecutionStatus.DEAD_LETTER) {
      await client.query(
        `UPDATE job_executions SET status = 'FAILED', next_retry_at = NOW() WHERE id = $1`,
        [executionId]
      );
    }
    await setOneTimeJobStatus(client, execution.job_id, ['COMPLETED', 'FAILED', 'SCHEDULED'], 'QUEUED');
    return { ok: true, execution: inserted[0] };
  });
}

/**
 * Cancels a PENDING or RUNNING execution. A PENDING row is simply never claimed; for a
 * RUNNING row the worker's next lease renewal finds it gone and aborts the handler.
 * @returns the cancelled execution, or null when it was not in a cancellable state
 */
export async function cancelExecution(executionId: string): Promise<JobExecution | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<JobExecution>(
      `UPDATE job_executions
       SET status = 'CANCELLED', completed_at = NOW(), error = 'Cancelled by user',
           lease_expires_at = NULL
       WHERE id = $1 AND status IN ('PENDING', 'RUNNING')
       RETURNING *`,
      [executionId]
    );
    if (rows.length === 0) {
      return null;
    }

    // A cancelled one-time job goes back to on-demand: it can be triggered again.
    await setOneTimeJobStatus(client, rows[0].job_id, ['QUEUED', 'RUNNING'], 'SCHEDULED');
    return rows[0];
  });
}

/** Queue depth by state, read straight from the execution table. */
export interface QueueStats {
  /** PENDING and claimable now. */
  queued: number;
  /** PENDING but waiting for run_at (retry backoff, breaker hold). */
  delayed: number;
  /** RUNNING under a lease. */
  processing: number;
  /** RUNNING with a lapsed lease the reaper has not handled yet. */
  expiredLeases: number;
  deadLetter: number;
}

/** Reads queue depth by state; the partial indexes keep this cheap. */
export async function getQueueStats(): Promise<QueueStats> {
  const rows = await query<Record<keyof QueueStats, string>>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'PENDING' AND run_at <= NOW()) AS "queued",
       COUNT(*) FILTER (WHERE status = 'PENDING' AND run_at > NOW()) AS "delayed",
       COUNT(*) FILTER (WHERE status = 'RUNNING') AS "processing",
       COUNT(*) FILTER (
         WHERE status = 'RUNNING' AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       ) AS "expiredLeases",
       COUNT(*) FILTER (WHERE status = 'DEAD_LETTER') AS "deadLetter"
     FROM job_executions
     WHERE status IN ('PENDING', 'RUNNING', 'DEAD_LETTER')`
  );
  const row = rows[0];
  return {
    queued: parseInt(row.queued, 10),
    delayed: parseInt(row.delayed, 10),
    processing: parseInt(row.processing, 10),
    expiredLeases: parseInt(row.expiredLeases, 10),
    deadLetter: parseInt(row.deadLetter, 10),
  };
}

/** A dead-lettered execution with enough job context to act on it. */
export interface DeadLetterItem extends JobExecution {
  job_name: string;
  handler: string;
}

/** Lists dead-lettered executions, most recent first. */
export async function listDeadLetter(limit: number, offset: number): Promise<DeadLetterItem[]> {
  return query<DeadLetterItem>(
    `SELECT e.*, j.name AS job_name, j.handler
     FROM job_executions e
     JOIN jobs j ON j.id = e.job_id
     WHERE e.status = 'DEAD_LETTER'
     ORDER BY e.completed_at DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}
