/**
 * The fixture panel: stands in for a Git host and for things going wrong. Every action
 * goes through the same path a real one would: a push creates a commit and sends a signed
 * webhook over HTTP. The panel chooses scenarios by name from a fixed catalog, so nothing
 * from a browser ever reaches a runner's shell.
 * @module api/routes/fixtures
 */
import { Router } from 'express'
import { z } from 'zod'
import { readableRepoIds, requireRepoMaintainer, requireRepoRead } from '../../shared/access.js'
import { userOf } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { decrypt } from '../../shared/crypto.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { SCENARIOS, scenarioByName, type Scenario } from '../../fixtures/catalog.js'
import { pullRequestPayload, pushPayload, sendWebhook, type SendResult } from '../../fixtures/generator.js'
import { createCommit } from '../../fixtures/store.js'
import { webhookAad } from './webhooks.js'

export const fixturesRouter = Router()

interface RepoSecret {
  id: string
  full_name: string
  default_branch: string
  webhook_secret_enc: string
}

async function loadRepo(repoId: string): Promise<RepoSecret> {
  const { rows } = await pool.query<RepoSecret>('SELECT id, full_name, default_branch, webhook_secret_enc FROM repositories WHERE id = $1', [repoId])
  if (!rows[0]) throw notFound('Repository')
  return rows[0]
}

async function pushScenario(repo: RepoSecret, scenario: Scenario, sender: string, options: { badSignature?: boolean; deliveryId?: string } = {}): Promise<SendResult & { commitSha: string }> {
  const secret = decrypt(repo.webhook_secret_enc, webhookAad(repo.id))
  const isPr = scenario.event === 'pull_request'
  const branch = scenario.branch ?? repo.default_branch
  const headRepo = scenario.fork ? `contributor/${repo.full_name.split('/')[1]}` : repo.full_name
  const commit = await createCommit(pool, repo.id, scenario, { branch, author: isPr && scenario.fork ? 'contributor' : sender, sourceRepo: scenario.fork ? headRepo : null })
  const payload = isPr ? pullRequestPayload(repo.full_name, commit, scenario.fork ? 'contributor' : sender, Math.floor(100 + Math.random() * 900), repo.default_branch, headRepo) : pushPayload(repo.full_name, commit, sender)
  const sent = await sendWebhook(config.selfUrl, repo.full_name, secret, scenario.event, payload, options)
  return { ...sent, commitSha: commit.sha }
}

fixturesRouter.get('/catalog', (_req, res) => {
  res.json({
    scenarios: SCENARIOS.filter((s) => !s.internal).map((s) => ({ name: s.name, title: s.title, description: s.description, event: s.event, fork: s.fork ?? false, killableStep: s.killableStep ?? null })),
  })
})

fixturesRouter.get(
  '/deliveries',
  asyncHandler(async (req, res) => {
    const ids = await readableRepoIds(pool, userOf(req))
    const { rows } = await pool.query<{ delivery_id: string; repo_id: string; full_name: string; event_type: string; branch: string; commit_sha: string; is_fork: boolean; outcome: string; outcome_detail: string | null; run_id: string | null; run_number: number | null; redeliveries: number; created_at: Date }>(
      `SELECT t.delivery_id, t.repo_id, r.full_name, t.event_type, t.branch, t.commit_sha, t.is_fork, t.outcome, t.outcome_detail, t.run_id, w.run_number, t.redeliveries, t.created_at
         FROM trigger_events t JOIN repositories r ON r.id = t.repo_id LEFT JOIN workflow_runs w ON w.id = t.run_id
        WHERE t.repo_id = ANY($1::text[]) ORDER BY t.created_at DESC LIMIT 25`,
      [ids],
    )
    res.json({
      deliveries: rows.map((d) => ({
        deliveryId: d.delivery_id,
        repoId: d.repo_id,
        repository: d.full_name,
        eventType: d.event_type,
        branch: d.branch,
        commitSha: d.commit_sha,
        isFork: d.is_fork,
        outcome: d.outcome,
        outcomeDetail: d.outcome_detail,
        runId: d.run_id,
        runNumber: d.run_number,
        redeliveries: d.redeliveries,
        createdAt: d.created_at.toISOString(),
      })),
    })
  }),
)

const triggerSchema = z.object({ repoId: z.string().max(100), scenario: z.string().max(64), killOnStep: z.boolean().default(false) }).strict()

fixturesRouter.post(
  '/trigger',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const body = triggerSchema.parse(req.body)
    await requireRepoMaintainer(pool, user, body.repoId)
    const scenario = scenarioByName(body.scenario)
    if (!scenario) throw new HttpError(404, 'UNKNOWN_SCENARIO', `No fixture scenario named "${body.scenario}"`)
    const repo = await loadRepo(body.repoId)
    const sent = await pushScenario(repo, scenario, user.username)
    const runId = typeof sent.body.runId === 'string' ? sent.body.runId : null
    if (body.killOnStep) {
      if (!scenario.killableStep) throw new HttpError(422, 'NOT_KILLABLE', 'This scenario has no step to kill the runner on')
      if (runId) await pool.query('INSERT INTO chaos_arms (run_id, step_name, armed_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [runId, scenario.killableStep, user.username])
    }
    res.status(sent.status).json({ ...sent.body, deliveryId: sent.deliveryId, commitSha: sent.commitSha, httpStatus: sent.status })
  }),
)

const redeliverSchema = z.object({ repoId: z.string().max(100), deliveryId: z.string().max(128) }).strict()

fixturesRouter.post(
  '/redeliver',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const body = redeliverSchema.parse(req.body)
    await requireRepoMaintainer(pool, user, body.repoId)
    const { rows } = await pool.query<{ event_type: string; payload: unknown }>('SELECT event_type, payload FROM trigger_events WHERE repo_id = $1 AND delivery_id = $2', [body.repoId, body.deliveryId])
    if (!rows[0]) throw notFound('Delivery')
    const repo = await loadRepo(body.repoId)
    const sent = await sendWebhook(config.selfUrl, repo.full_name, decrypt(repo.webhook_secret_enc, webhookAad(repo.id)), rows[0].event_type, rows[0].payload, { deliveryId: body.deliveryId })
    res.status(sent.status).json({ ...sent.body, deliveryId: sent.deliveryId, httpStatus: sent.status })
  }),
)

fixturesRouter.post(
  '/bad-signature',
  asyncHandler(async (req, res) => {
    const body = z.object({ repoId: z.string().max(100) }).strict().parse(req.body)
    await requireRepoMaintainer(pool, userOf(req), body.repoId)
    const repo = await loadRepo(body.repoId)
    const scenario = scenarioByName('burst') as Scenario
    const sent = await pushScenario(repo, scenario, 'attacker', { badSignature: true })
    res.json({ httpStatus: sent.status, deliveryId: sent.deliveryId, response: sent.body })
  }),
)

const burstSchema = z.object({ repoId: z.string().max(100), count: z.number().int().min(1).max(100), otherRepoId: z.string().max(100).optional(), otherCount: z.number().int().min(0).max(20).default(0) }).strict()

/** Fires a burst of signed pushes as fast as intake takes them. The committed load script does the same from outside. */
fixturesRouter.post(
  '/burst',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const body = burstSchema.parse(req.body)
    await requireRepoMaintainer(pool, user, body.repoId)
    if (body.otherRepoId) await requireRepoRead(pool, user, body.otherRepoId)
    const scenario = scenarioByName('burst') as Scenario
    const startedAt = new Date().toISOString()
    const repo = await loadRepo(body.repoId)
    const results = await Promise.all(Array.from({ length: body.count }, () => pushScenario(repo, scenario, user.username)))
    let other = 0
    if (body.otherRepoId && body.otherCount > 0) {
      await requireRepoMaintainer(pool, user, body.otherRepoId)
      const otherRepo = await loadRepo(body.otherRepoId)
      other = (await Promise.all(Array.from({ length: body.otherCount }, () => pushScenario(otherRepo, scenario, user.username)))).length
    }
    res.status(202).json({ startedAt, accepted: results.filter((r) => r.status === 202).length, otherAccepted: other })
  }),
)

/**
 * The next heartbeat tells this runner to SIGKILL itself. Only a maintainer of whatever
 * it is running (or an admin): runners are shared, and this is a demo control, not a right
 * to stop another organization's job.
 */
fixturesRouter.post(
  '/kill-runner',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const body = z.object({ runnerId: z.string().max(100) }).strict().parse(req.body)
    if (!user.isAdmin) {
      const { rows } = await pool.query<{ repo_id: string }>(`SELECT DISTINCT repo_id FROM jobs WHERE runner_id = $1 AND status = 'running'`, [body.runnerId])
      for (const r of rows) await requireRepoMaintainer(pool, user, r.repo_id)
      const maintains = await pool.query(`SELECT 1 FROM repo_members WHERE user_id = $1 AND role = 'maintainer' LIMIT 1`, [user.id])
      if (maintains.rows.length === 0) throw new HttpError(403, 'FORBIDDEN', 'Only a maintainer can use the runner kill switch')
    }
    const { rowCount } = await pool.query('UPDATE runners SET kill_requested = true WHERE id = $1', [body.runnerId])
    if (!rowCount) throw notFound('Runner')
    res.status(202).json({ runnerId: body.runnerId, killRequested: true })
  }),
)
