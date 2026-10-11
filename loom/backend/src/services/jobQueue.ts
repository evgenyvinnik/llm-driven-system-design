import type { PoolClient } from 'pg';
import { pool } from './db.js';

/**
 * A small work queue in PostgreSQL, one row per (video, kind).
 *
 * Workers claim with FOR UPDATE SKIP LOCKED, so two workers never take the same row
 * and neither waits on the other. A claim is a lease (`locked_until`); a worker that
 * dies simply lets it expire and the next claim picks the job up again. Each claim
 * increments `attempts`, which doubles as a fencing token: a worker whose lease expired
 * can no longer finish or fail the job, because its (locked_by, attempts) pair no longer
 * matches the row.
 */
export interface Job {
  id: string;
  video_id: string;
  kind: string;
  status: string;
  attempts: number;
  locked_by: string | null;
}

type Queryable = Pick<PoolClient, 'query'>;

/** Enqueues a job inside the caller's transaction; a second enqueue for the same video and kind is a no-op. */
export async function enqueueJob(db: Queryable, videoId: string, kind: string): Promise<void> {
  await db.query(
    `INSERT INTO video_jobs (video_id, kind) VALUES ($1, $2)
     ON CONFLICT (video_id, kind) DO NOTHING`,
    [videoId, kind],
  );
}

/** Claims the next runnable job (queued and due, or running with an expired lease). */
export async function claimJob(workerId: string, leaseSeconds: number): Promise<Job | null> {
  const { rows } = await pool.query(
    `UPDATE video_jobs
     SET status = 'running', attempts = attempts + 1, locked_by = $1,
         locked_until = NOW() + make_interval(secs => $2::int), updated_at = NOW()
     WHERE id = (
       SELECT id FROM video_jobs
       WHERE (status = 'queued' AND run_after <= NOW())
          OR (status = 'running' AND locked_until < NOW())
       ORDER BY run_after
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, video_id, kind, status, attempts, locked_by`,
    [workerId, leaseSeconds],
  );
  return rows[0] ?? null;
}

/**
 * Marks a job done if this worker still holds it. Run it in the same transaction as the
 * job's own writes: when it returns false the lease was lost and the caller rolls back.
 */
export async function markJobDone(db: Queryable, job: Job, workerId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE video_jobs
     SET status = 'done', locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = NOW()
     WHERE id = $1 AND status = 'running' AND locked_by = $2 AND attempts = $3`,
    [job.id, workerId, job.attempts],
  );
  return rowCount === 1;
}

/** Exponential backoff between attempts: 10 s, 20 s, 40 s ... capped at 10 minutes. */
export function backoffSeconds(attempts: number): number {
  return Math.min(600, 10 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Records a failed attempt: back to `queued` with backoff, or `dead` once attempts are
 * exhausted. Returns what happened; 'lost' means another worker owns the job now.
 */
export async function failJob(
  job: Job,
  workerId: string,
  error: unknown,
  maxAttempts: number,
): Promise<'retry' | 'dead' | 'lost'> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const dead = job.attempts >= maxAttempts;
  const { rowCount } = await pool.query(
    `UPDATE video_jobs
     SET status = $4, last_error = $5, locked_by = NULL, locked_until = NULL,
         run_after = NOW() + make_interval(secs => $6::int), updated_at = NOW()
     WHERE id = $1 AND status = 'running' AND locked_by = $2 AND attempts = $3`,
    [job.id, workerId, job.attempts, dead ? 'dead' : 'queued', message, backoffSeconds(job.attempts)],
  );
  if (rowCount !== 1) return 'lost';
  return dead ? 'dead' : 'retry';
}
