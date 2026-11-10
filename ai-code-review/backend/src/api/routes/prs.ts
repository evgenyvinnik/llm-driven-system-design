/**
 * Pull request queue and detail, plus the two PR-level actions: re-run a review
 * and report a dangerous false approval.
 * @module api/routes/prs
 */
import { Router } from 'express'
import { z } from 'zod'
import { canAccessOrg, requireAuth, requireRepoAdmin, userOf } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { httpHostReader } from '../../shared/host-client.js'
import { loadRepoByName, repoDto, type RepoRow } from '../../shared/repos.js'
import { createRun } from '../../shared/review-state.js'
import type { DecisionRow, EscalationRow, IntentRow, PrRow, RunRow } from '../../shared/rows.js'
import { reportFalseApproval } from '../services/repo-modes.js'
import { auditDto, decisionDto, escalationDto, intentDto, listPullRequests, runDto, type AuditRow } from '../services/views.js'

export const prsRouter = Router()
prsRouter.use(requireAuth)

prsRouter.get(
  '/prs',
  asyncHandler(async (req, res) => {
    const prs = await listPullRequests(userOf(req), {
      repo: req.query.repo as string | undefined,
      outcome: req.query.outcome as string | undefined,
      overruled: req.query.overruled === 'true',
      limit: Math.min(Number(req.query.limit ?? 200), 500),
    })
    res.json({ prs })
  }),
)

prsRouter.get(
  '/prs/:owner/:repo/:number',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const repo = await loadRepoByName(pool, `${req.params.owner}/${req.params.repo}`)
    if (!repo || !canAccessOrg(user, repo.org_id)) throw notFound('Pull request')
    const prRes = await pool.query<PrRow>(`SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2`, [repo.id, Number(req.params.number)])
    const pr = prRes.rows[0]
    if (!pr) throw notFound('Pull request')
    const [runs, decisions, escalations, intents, audit] = await Promise.all([
      pool.query<RunRow>(`SELECT * FROM review_runs WHERE pr_id = $1 ORDER BY created_at DESC`, [pr.id]),
      pool.query<DecisionRow>(`SELECT * FROM decisions WHERE pr_id = $1 ORDER BY created_at DESC`, [pr.id]),
      pool.query<EscalationRow>(`SELECT * FROM escalations WHERE pr_id = $1 ORDER BY created_at DESC`, [pr.id]),
      pool.query<IntentRow>(`SELECT * FROM post_intents WHERE pr_id = $1 ORDER BY created_at DESC`, [pr.id]),
      pool.query<AuditRow>(`SELECT a.*, r.full_name FROM audit_log a JOIN repositories r ON r.id = a.repo_id WHERE a.repo_id = $1 AND a.pr_number = $2 ORDER BY a.seq`, [repo.id, pr.number]),
    ])
    // Live view of the host. A failure here costs a panel, not the page.
    const [hostReviews, mergeBlockers] = await Promise.all([httpHostReader.listReviews(repo.full_name, pr.number).catch(() => null), httpHostReader.mergeBlockers(repo.full_name, pr.number).catch(() => null)])
    res.json({
      repo: repoDto(repo),
      pr: { number: pr.number, title: pr.title, author: pr.author, baseRef: pr.base_ref, headSha: pr.head_sha, headSeq: pr.head_seq, state: pr.state, createdAt: pr.created_at.toISOString(), updatedAt: pr.updated_at.toISOString() },
      runs: runs.rows.map(runDto),
      decisions: decisions.rows.map(decisionDto),
      escalations: escalations.rows.map(escalationDto),
      intents: intents.rows.map(intentDto),
      timeline: audit.rows.map(auditDto),
      hostReviews,
      mergeBlockers,
    })
  }),
)

prsRouter.post(
  '/prs/:owner/:repo/:number/rerun',
  requireRepoAdmin,
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const repo = await loadRepoByName(pool, `${req.params.owner}/${req.params.repo}`)
    if (!repo || !canAccessOrg(user, repo.org_id)) throw notFound('Pull request')
    const runId = await withTransaction(async (tx) => {
      const locked = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2 FOR UPDATE`, [repo.id, Number(req.params.number)])
      if (!locked.rows[0]) throw notFound('Pull request')
      return createRun(tx, repo as RepoRow, locked.rows[0], 'full', `manual:${user.username}`, user.username)
    })
    if (!runId) throw new HttpError(409, 'RUN_ACTIVE', 'A review is already running for this commit')
    res.status(202).json({ runId })
  }),
)

prsRouter.post(
  '/decisions/:id/report-false-approval',
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: z.string().max(1000).optional() }).strict().parse(req.body ?? {})
    res.json(await reportFalseApproval(req.params.id, userOf(req), note))
  }),
)

