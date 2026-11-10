/**
 * The runner fleet, as people see it. Runners are shared, so a job from a repository
 * the viewer can't read shows only as "busy": its lease, not its name.
 * @module api/routes/runners
 */
import { Router } from 'express'
import { readableRepoIds } from '../../shared/access.js'
import { userOf } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'

export const runnersRouter = Router()

runnersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const repoIds = new Set(await readableRepoIds(pool, userOf(req)))
    const { rows } = await pool.query<{ id: string; name: string; labels: string[]; slots: number; pid: number | null; incarnation: number; registered_at: Date; last_seen_ms: number }>(
      `SELECT id, name, labels, slots, pid, incarnation, registered_at, (EXTRACT(EPOCH FROM (now() - last_seen_at)) * 1000)::int AS last_seen_ms FROM runners ORDER BY name`,
    )
    const jobs = await pool.query<{ id: string; run_id: string; repo_id: string; full_name: string; job_key: string; name: string; attempt: number; runner_id: string; fencing_token: number; lease_ms: number; heartbeat_ms: number; run_number: number }>(
      `SELECT j.id, j.run_id, j.repo_id, r.full_name, j.job_key, j.name, j.attempt, j.runner_id, j.fencing_token, w.run_number,
              (EXTRACT(EPOCH FROM (j.lease_expires_at - now())) * 1000)::int AS lease_ms,
              (EXTRACT(EPOCH FROM (now() - j.last_heartbeat_at)) * 1000)::int AS heartbeat_ms
         FROM jobs j JOIN repositories r ON r.id = j.repo_id JOIN workflow_runs w ON w.id = j.run_id
        WHERE j.status = 'running'`,
    )
    res.json({
      leaseMs: config.lease.ms,
      runners: rows.map((r) => ({
        id: r.id,
        name: r.name,
        labels: r.labels,
        slots: r.slots,
        pid: r.pid,
        incarnation: r.incarnation,
        registeredAt: r.registered_at.toISOString(),
        lastSeenMs: r.last_seen_ms,
        online: r.last_seen_ms < config.runnerOfflineMs,
        jobs: jobs.rows
          .filter((j) => j.runner_id === r.id)
          .map((j) =>
            repoIds.has(j.repo_id)
              ? { visible: true as const, jobId: j.id, runId: j.run_id, runNumber: j.run_number, repository: j.full_name, jobName: j.name, attempt: j.attempt, fencingToken: j.fencing_token, leaseExpiresInMs: j.lease_ms, lastHeartbeatMs: j.heartbeat_ms }
              : { visible: false as const, leaseExpiresInMs: j.lease_ms, lastHeartbeatMs: j.heartbeat_ms },
          ),
      })),
    })
  }),
)
