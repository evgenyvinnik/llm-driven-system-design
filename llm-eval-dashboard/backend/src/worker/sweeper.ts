/**
 * Housekeeping that no single task write can do, run by whichever worker
 * holds the advisory lock this tick:
 * - finalize running runs whose last write came from a worker that died
 *   before calling finalizeRun;
 * - cancelled runs: flip leftover pending tasks (a retry written just after
 *   the cancel) and expired leases to cancelled, and pending scores too.
 * Expired leases of live runs need no sweep: the claim query re-claims them.
 * @module worker/sweeper
 */
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { finalizeRun } from './tasks.js'

const SWEEP_LOCK = 724_001

export async function sweepOnce(): Promise<{ finalized: number; cancelledTasks: number }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [SWEEP_LOCK])
    if (!lock.rows[0].ok) {
      await client.query('COMMIT')
      return { finalized: 0, cancelledTasks: 0 }
    }
    const cancelled = await client.query(
      `UPDATE case_results c SET status = 'cancelled', finished_at = now(), finish_reason = 'cancelled',
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         FROM eval_runs r
        WHERE r.id = c.run_id AND r.status = 'cancelled'
          AND (c.status = 'pending' OR (c.status = 'running' AND c.lease_expires_at <= now()))`,
    )
    await client.query(
      `UPDATE case_attempts a SET outcome = 'cancelled', finished_at = now()
         FROM case_results c, eval_runs r
        WHERE a.case_result_id = c.id AND c.run_id = r.id AND r.status = 'cancelled' AND c.status = 'cancelled' AND a.outcome = 'in_progress'`,
    )
    await client.query(
      `UPDATE scores s SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         FROM eval_runs r
        WHERE r.id = s.run_id AND r.status = 'cancelled' AND s.created_at < r.cancel_requested_at
          AND (s.status = 'pending' OR (s.status = 'running' AND s.lease_expires_at <= now()))`,
    )
    await client.query('COMMIT')
    const running = await pool.query<{ id: string }>(`SELECT id FROM eval_runs WHERE status = 'running'`)
    let finalized = 0
    for (const r of running.rows) if (await finalizeRun(pool, r.id)) finalized++
    if (finalized > 0 || (cancelled.rowCount ?? 0) > 0) logger.info({ finalized, cancelledTasks: cancelled.rowCount }, 'sweep')
    return { finalized, cancelledTasks: cancelled.rowCount ?? 0 }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/** Run ids among `runIds` that are cancelled (fallback for a missed NOTIFY). */
export async function cancelledAmong(runIds: string[]): Promise<string[]> {
  if (runIds.length === 0) return []
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM eval_runs WHERE id = ANY($1::text[]) AND status = 'cancelled'`, [runIds])
  return rows.map((r) => r.id)
}
