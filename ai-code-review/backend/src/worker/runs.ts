/**
 * The run queue: claim with SKIP LOCKED, lease, heartbeat. A worker that dies
 * leaves its run `running` with an expiring lease; the next claim takes it over
 * with a new token, and the old worker's fenced writes then affect nothing.
 * Lease expiry uses the database clock, never a host clock.
 * @module worker/runs
 */
import { pool } from '../shared/db.js'
import { config } from '../shared/config.js'
import { newLeaseToken } from '../shared/ids.js'
import { leasesReclaimed } from '../shared/metrics.js'
import type { RunRow } from '../shared/rows.js'

export async function claimNextRun(instanceId: string): Promise<RunRow | null> {
  const token = newLeaseToken()
  const res = await pool.query<RunRow>(
    `WITH next AS (
       SELECT id FROM review_runs
       WHERE status = 'queued' OR (status = 'running' AND lease_expires_at < now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE review_runs r
     SET status = 'running',
         attempt = r.attempt + 1,
         claimed_by = $1,
         lease_token = $2,
         lease_expires_at = now() + ($3 || ' milliseconds')::interval,
         started_at = COALESCE(r.started_at, now()),
         queue_ms = COALESCE(r.queue_ms, (EXTRACT(EPOCH FROM (now() - r.created_at)) * 1000)::int)
     FROM next
     WHERE r.id = next.id
     RETURNING r.*`,
    [instanceId, token, String(config.worker.leaseMs)],
  )
  const run = res.rows[0] ?? null
  if (run && run.attempt > 1) leasesReclaimed.inc()
  return run
}

export async function heartbeat(runId: string, token: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE review_runs SET lease_expires_at = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND lease_token = $2 AND status = 'running'`,
    [runId, token, String(config.worker.leaseMs)],
  )
  return (res.rowCount ?? 0) > 0
}
