/**
 * Repositories and what hangs off them: runs, environments, secrets (metadata only),
 * the secret release audit, and recent deliveries.
 * @module api/routes/repos
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireRepoMaintainer, requireRepoRead, readableRepoIds } from '../../shared/access.js'
import { userOf } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { deleteSecret, listSecrets, putSecret } from '../../secrets/store.js'
import { runDto, type RunDbRow } from '../services/dto.js'

export const reposRouter = Router()

reposRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const ids = await readableRepoIds(pool, user)
    const { rows } = await pool.query<{
      id: string
      full_name: string
      default_branch: string
      max_concurrent_jobs: number
      org_name: string
      role: string | null
      running: number
      queued: number
      attention: number
      total_runs: number
      last_run: RunDbRow | null
    }>(
      `SELECT r.id, r.full_name, r.default_branch, r.max_concurrent_jobs, o.name AS org_name,
              (SELECT role FROM repo_members m WHERE m.repo_id = r.id AND m.user_id = $2) AS role,
              (SELECT count(*)::int FROM jobs j WHERE j.repo_id = r.id AND j.status = 'running') AS running,
              (SELECT count(*)::int FROM jobs j WHERE j.repo_id = r.id AND j.status = 'queued') AS queued,
              (SELECT count(*)::int FROM jobs j WHERE j.repo_id = r.id AND j.status = 'needs_attention') AS attention,
              (SELECT count(*)::int FROM workflow_runs w WHERE w.repo_id = r.id) AS total_runs,
              (SELECT row_to_json(w) FROM workflow_runs w WHERE w.repo_id = r.id ORDER BY w.run_number DESC LIMIT 1) AS last_run
         FROM repositories r JOIN orgs o ON o.id = r.org_id
        WHERE r.id = ANY($1::text[]) ORDER BY r.full_name`,
      [ids, user.id],
    )
    res.json({
      repositories: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        org: r.org_name,
        role: r.role ?? 'read',
        maxConcurrentJobs: r.max_concurrent_jobs,
        runningJobs: r.running,
        queuedJobs: r.queued,
        attentionJobs: r.attention,
        totalRuns: r.total_runs,
        lastRun: r.last_run ? runDto(r.last_run) : null,
      })),
    })
  }),
)

reposRouter.get(
  '/:repoId',
  asyncHandler(async (req, res) => {
    const role = await requireRepoRead(pool, userOf(req), req.params.repoId)
    const { rows } = await pool.query<{ id: string; full_name: string; default_branch: string; max_concurrent_jobs: number }>('SELECT id, full_name, default_branch, max_concurrent_jobs FROM repositories WHERE id = $1', [req.params.repoId])
    if (!rows[0]) throw notFound('Repository')
    const r = rows[0]
    res.json({ repository: { id: r.id, fullName: r.full_name, defaultBranch: r.default_branch, maxConcurrentJobs: r.max_concurrent_jobs, role, webhookUrl: `/api/v1/webhooks/${r.full_name}` } })
  }),
)

const listQuery = z.object({ status: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.coerce.number().int().positive().optional() })

reposRouter.get(
  '/:repoId/runs',
  asyncHandler(async (req, res) => {
    await requireRepoRead(pool, userOf(req), req.params.repoId)
    const q = listQuery.parse(req.query)
    const { rows } = await pool.query<RunDbRow & { job_counts: Record<string, number> | null; redeliveries: number; delivery_id: string }>(
      `SELECT w.*, t.redeliveries, t.delivery_id,
              (SELECT json_object_agg(s.status, s.n) FROM (SELECT status, count(*)::int AS n FROM jobs j WHERE j.run_id = w.id GROUP BY status) s) AS job_counts
         FROM workflow_runs w JOIN trigger_events t ON t.id = w.trigger_event_id
        WHERE w.repo_id = $1 AND ($2::text IS NULL OR w.status = $2) AND ($3::int IS NULL OR w.run_number < $3)
        ORDER BY w.run_number DESC LIMIT $4`,
      [req.params.repoId, q.status ?? null, q.before ?? null, q.limit],
    )
    res.json({ runs: rows.map((r) => ({ ...runDto(r), jobCounts: r.job_counts ?? {}, redeliveries: r.redeliveries, deliveryId: r.delivery_id })) })
  }),
)

reposRouter.get(
  '/:repoId/environments',
  asyncHandler(async (req, res) => {
    await requireRepoRead(pool, userOf(req), req.params.repoId)
    const { rows } = await pool.query<{ id: string; name: string; required_approval: boolean; allowed_branches: string[]; secret_count: number }>(
      `SELECT e.id, e.name, e.required_approval, e.allowed_branches, (SELECT count(*)::int FROM secrets s WHERE s.environment_id = e.id) AS secret_count
         FROM environments e WHERE e.repo_id = $1 ORDER BY e.name`,
      [req.params.repoId],
    )
    res.json({ environments: rows.map((e) => ({ id: e.id, name: e.name, requiredApproval: e.required_approval, allowedBranches: e.allowed_branches, secretCount: e.secret_count })) })
  }),
)

const environmentSchema = z.object({ requiredApproval: z.boolean(), allowedBranches: z.array(z.string().min(1).max(100)).max(20) }).strict()

reposRouter.put(
  '/:repoId/environments/:name',
  asyncHandler(async (req, res) => {
    await requireRepoMaintainer(pool, userOf(req), req.params.repoId)
    const name = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).parse(req.params.name)
    const body = environmentSchema.parse(req.body)
    await pool.query(
      `INSERT INTO environments (id, repo_id, name, required_approval, allowed_branches) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (repo_id, name) DO UPDATE SET required_approval = EXCLUDED.required_approval, allowed_branches = EXCLUDED.allowed_branches`,
      [newId('env'), req.params.repoId, name, body.requiredApproval, body.allowedBranches],
    )
    res.json({ environment: { name, ...body } })
  }),
)

reposRouter.get(
  '/:repoId/secrets',
  asyncHandler(async (req, res) => {
    await requireRepoRead(pool, userOf(req), req.params.repoId)
    res.json({ secrets: await listSecrets(pool, req.params.repoId) })
  }),
)

const secretSchema = z.object({ name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'must be UPPER_SNAKE_CASE'), value: z.string().min(6, 'must be at least 6 characters, or it cannot be masked').max(16_384), environment: z.string().max(64).nullable().optional() }).strict()

reposRouter.put(
  '/:repoId/secrets',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    await requireRepoMaintainer(pool, user, req.params.repoId)
    const body = secretSchema.parse(req.body)
    const { id, created } = await putSecret(pool, req.params.repoId, body.name, body.value, body.environment, user.username)
    // Metadata only: the value is write-only from here on.
    res.status(created ? 201 : 200).json({ secret: { id, name: body.name, environment: body.environment ?? null } })
  }),
)

reposRouter.delete(
  '/:repoId/secrets/:secretId',
  asyncHandler(async (req, res) => {
    await requireRepoMaintainer(pool, userOf(req), req.params.repoId)
    await deleteSecret(pool, req.params.repoId, req.params.secretId)
    res.status(204).end()
  }),
)

reposRouter.get(
  '/:repoId/secret-releases',
  asyncHandler(async (req, res) => {
    await requireRepoRead(pool, userOf(req), req.params.repoId)
    const { rows } = await pool.query<{ id: number; secret_name: string; scope: string; run_id: string; run_number: number | null; job_id: string; job_key: string; attempt: number; runner_name: string; released_at: Date }>(
      `SELECT r.id, r.secret_name, r.scope, r.run_id, w.run_number, r.job_id, r.job_key, r.attempt, r.runner_name, r.released_at
         FROM secret_releases r LEFT JOIN workflow_runs w ON w.id = r.run_id
        WHERE r.repo_id = $1 ORDER BY r.released_at DESC LIMIT 100`,
      [req.params.repoId],
    )
    res.json({
      releases: rows.map((r) => ({ id: r.id, secretName: r.secret_name, scope: r.scope, runId: r.run_id, runNumber: r.run_number, jobId: r.job_id, jobKey: r.job_key, attempt: r.attempt, runnerName: r.runner_name, releasedAt: r.released_at.toISOString() })),
    })
  }),
)
