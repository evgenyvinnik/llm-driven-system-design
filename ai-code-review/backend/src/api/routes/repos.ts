/**
 * Repository settings, modes and the kill switch. This is where policy lives and
 * how it changes. It is never read from the repository itself.
 * @module api/routes/repos
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireRepoAdmin, userOf } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { POLICY_VERSION } from '../../shared/gate/rules.js'
import { newId } from '../../shared/ids.js'
import { DEFAULT_POLICY, MODEL_VERSIONS, repoDto, type RepoRow } from '../../shared/repos.js'
import { demoteRepo, loadScopedRepo, previewPromotion, promoteRepo, setKillSwitch, settingsPatch, shadowStats, updateSettings } from '../services/repo-modes.js'
import { orgFilter } from '../services/views.js'

export const reposRouter = Router()
reposRouter.use(requireAuth)

reposRouter.get(
  '/repos',
  asyncHandler(async (req, res) => {
    const scope = orgFilter(userOf(req))
    const rows = await pool.query<RepoRow>(`SELECT r.* FROM repositories r WHERE ${scope.sql} ORDER BY r.full_name`, scope.params)
    res.json({ repos: rows.rows.map(repoDto), policyVersion: POLICY_VERSION, modelVersions: MODEL_VERSIONS })
  }),
)

const createBody = z.object({ fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/), modelVersion: z.enum(MODEL_VERSIONS).optional() }).strict()

// A repository always starts in observe. There is no way to register one with approvals on.
reposRouter.post(
  '/repos',
  requireRepoAdmin,
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const body = createBody.parse(req.body)
    if (!user.orgId) throw new HttpError(422, 'ORG_REQUIRED', 'Register a repository as a member of its org')
    const p = DEFAULT_POLICY
    const id = newId('repo')
    const inserted = await pool.query<RepoRow>(
      `INSERT INTO repositories (id, org_id, full_name, protected_paths, ci_config_paths, policy_paths, max_files, max_changed_lines, auto_approve_scope, required_checks, required_reviewers, bot_logins, link_allowlist, model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (full_name) DO NOTHING RETURNING *`,
      [id, user.orgId, body.fullName, JSON.stringify(p.protectedPaths), JSON.stringify(p.ciConfigPaths), JSON.stringify(p.policyPaths), p.maxFiles, p.maxChangedLines, JSON.stringify(p.autoApproveScope), JSON.stringify(p.requiredChecks), JSON.stringify(p.requiredReviewers), JSON.stringify(p.botLogins), JSON.stringify(p.linkAllowlist), body.modelVersion ?? MODEL_VERSIONS[0]],
    )
    if (!inserted.rows[0]) throw new HttpError(409, 'ALREADY_REGISTERED', 'That repository is already registered')
    res.status(201).json({ repo: repoDto(inserted.rows[0]) })
  }),
)

reposRouter.get(
  '/repos/:id',
  asyncHandler(async (req, res) => {
    const repo = await loadScopedRepo(req.params.id, userOf(req))
    const history = await pool.query(`SELECT id, kind, from_mode, to_mode, actor, reason, evaluation_id, created_at FROM mode_changes WHERE repo_id = $1 ORDER BY created_at DESC LIMIT 20`, [repo.id])
    res.json({
      repo: repoDto(repo),
      policyVersion: POLICY_VERSION,
      modelVersions: MODEL_VERSIONS,
      promotion: await previewPromotion(repo),
      shadow: await shadowStats(repo),
      modeChanges: history.rows.map((m) => ({ id: m.id, kind: m.kind, fromMode: m.from_mode, toMode: m.to_mode, actor: m.actor, reason: m.reason, evaluationId: m.evaluation_id, createdAt: m.created_at.toISOString() })),
    })
  }),
)

reposRouter.patch(
  '/repos/:id',
  requireRepoAdmin,
  asyncHandler(async (req, res) => {
    await updateSettings(req.params.id, userOf(req), settingsPatch.parse(req.body))
    res.json({ repo: repoDto(await loadScopedRepo(req.params.id, userOf(req))) })
  }),
)

reposRouter.post(
  '/repos/:id/promote',
  requireRepoAdmin,
  asyncHandler(async (req, res) => {
    res.json({ repo: repoDto(await promoteRepo(req.params.id, userOf(req))) })
  }),
)

reposRouter.post(
  '/repos/:id/demote',
  requireRepoAdmin,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).strict().parse(req.body)
    await demoteRepo(req.params.id, userOf(req), reason)
    res.json({ repo: repoDto(await loadScopedRepo(req.params.id, userOf(req))) })
  }),
)

reposRouter.post(
  '/repos/:id/kill-switch',
  requireRepoAdmin,
  asyncHandler(async (req, res) => {
    const { on, reason } = z.object({ on: z.boolean(), reason: z.string().max(500).optional() }).strict().parse(req.body)
    await setKillSwitch(req.params.id, userOf(req), on, reason)
    res.json({ repo: repoDto(await loadScopedRepo(req.params.id, userOf(req))) })
  }),
)
