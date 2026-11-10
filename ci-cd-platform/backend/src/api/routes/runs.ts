/**
 * A run and its graph: detail, the pinned workflow source, cancel, re-run.
 * @module api/routes/runs
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireRepoMaintainer, requireRepoRead } from '../../shared/access.js'
import { userOf } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { cancelRun, rerun } from '../../scheduling/engine.js'
import { artifactDto, jobDto, runDto, type ArtifactDbRow, type JobDbRow, type RunDbRow } from '../services/dto.js'

export const runsRouter = Router()

async function loadRun(runId: string): Promise<RunDbRow> {
  const { rows } = await pool.query<RunDbRow>('SELECT * FROM workflow_runs WHERE id = $1', [runId])
  if (!rows[0]) throw notFound('Run')
  return rows[0]
}

runsRouter.get(
  '/:runId',
  asyncHandler(async (req, res) => {
    const run = await loadRun(req.params.runId)
    const role = await requireRepoRead(pool, userOf(req), run.repo_id).catch(() => {
      throw notFound('Run')
    })
    const [jobs, artifacts, trigger, repo, withheld] = await Promise.all([
      pool.query<JobDbRow>('SELECT * FROM jobs WHERE run_id = $1 ORDER BY created_at, job_key', [run.id]),
      pool.query<ArtifactDbRow>('SELECT * FROM artifacts WHERE run_id = $1 ORDER BY job_key, attempt, name', [run.id]),
      pool.query<{ delivery_id: string; redeliveries: number; last_received_at: Date; created_at: Date }>(`SELECT delivery_id, redeliveries, last_received_at, created_at FROM trigger_events WHERE id = (SELECT trigger_event_id FROM workflow_runs WHERE id = $1)`, [run.id]),
      pool.query<{ full_name: string }>('SELECT full_name FROM repositories WHERE id = $1', [run.repo_id]),
      pool.query<{ job_id: string; attempt: number; secrets_released: string[]; secrets_withheld: { name: string; reason: string }[]; runner_name: string | null; decision: string | null; decided_by: string | null }>(
        `SELECT a.job_id, a.attempt, a.secrets_released, a.secrets_withheld, a.runner_name, ap.decision, ap.decided_by
           FROM job_attempts a JOIN jobs j ON j.id = a.job_id AND j.attempt = a.attempt
           LEFT JOIN environment_approvals ap ON ap.job_id = a.job_id AND ap.attempt = a.attempt
          WHERE a.run_id = $1`,
        [run.id],
      ),
    ])
    const perJob = new Map(withheld.rows.map((a) => [a.job_id, a]))
    res.json({
      run: { ...runDto(run), repositoryName: repo.rows[0]?.full_name ?? null },
      canManage: role === 'maintainer',
      trigger: trigger.rows[0] ? { deliveryId: trigger.rows[0].delivery_id, redeliveries: trigger.rows[0].redeliveries, receivedAt: trigger.rows[0].created_at.toISOString(), lastReceivedAt: trigger.rows[0].last_received_at.toISOString() } : null,
      jobs: jobs.rows.map((j) => {
        const a = perJob.get(j.id)
        return { ...jobDto(j), secretsReleased: a?.secrets_released ?? [], secretsWithheld: a?.secrets_withheld ?? [], approval: a?.decision ? { decision: a.decision, by: a.decided_by } : null, lastRunnerName: a?.runner_name ?? null }
      }),
      artifacts: artifacts.rows.map(artifactDto),
    })
  }),
)

runsRouter.get(
  '/:runId/workflow',
  asyncHandler(async (req, res) => {
    const run = await loadRun(req.params.runId)
    await requireRepoRead(pool, userOf(req), run.repo_id).catch(() => {
      throw notFound('Run')
    })
    const { rows } = await pool.query<{ content: string }>('SELECT content FROM workflow_files WHERE sha = $1', [run.workflow_sha])
    res.json({ path: run.workflow_path, sha: run.workflow_sha, commitSha: run.commit_sha, content: rows[0]?.content ?? '' })
  }),
)

runsRouter.post(
  '/:runId/cancel',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const run = await loadRun(req.params.runId)
    await requireRepoMaintainer(pool, user, run.repo_id)
    res.json(await cancelRun(run.id, user.username))
  }),
)

const rerunSchema = z.object({ mode: z.enum(['failed', 'all']), confirmNonIdempotent: z.boolean().default(false) }).strict()

runsRouter.post(
  '/:runId/rerun',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const run = await loadRun(req.params.runId)
    await requireRepoMaintainer(pool, user, run.repo_id)
    const body = rerunSchema.parse(req.body ?? {})
    res.json(await rerun({ runId: run.id, mode: body.mode, actor: user.username, confirmNonIdempotent: body.confirmNonIdempotent }))
  }),
)
