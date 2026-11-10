/**
 * The audit log: filterable reads, and a tamper check that walks the chain.
 * @module api/routes/audit
 */
import { Router } from 'express'
import { z } from 'zod'
import { canAccessOrg, requireAuth, userOf } from '../../shared/auth.js'
import { verifyChain } from '../../shared/audit.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { loadRepo, type RepoRow } from '../../shared/repos.js'
import { auditDto, orgFilter, type AuditRow } from '../services/views.js'

export const auditRouter = Router()
auditRouter.use(requireAuth)

auditRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const scope = orgFilter(user)
    const params: unknown[] = [...scope.params]
    const where = [scope.sql]
    const filter = (clause: (i: number) => string, value: unknown) => {
      params.push(value)
      where.push(clause(params.length))
    }
    if (req.query.repo) filter((i) => `r.full_name = $${i}`, req.query.repo)
    if (req.query.kind) filter((i) => `a.kind = $${i}`, req.query.kind)
    if (req.query.actor) filter((i) => `a.actor = $${i}`, req.query.actor)
    if (req.query.pr) filter((i) => `a.pr_number = $${i}`, Number(req.query.pr))
    if (req.query.sha) filter((i) => `a.head_sha LIKE $${i}`, `${String(req.query.sha)}%`)
    const limit = Math.min(Number(req.query.limit ?? 100), 500)
    params.push(limit)
    const rows = await pool.query<AuditRow>(
      `SELECT a.*, r.full_name FROM audit_log a JOIN repositories r ON r.id = a.repo_id
       WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.seq DESC LIMIT $${params.length}`,
      params,
    )
    const kinds = await pool.query<{ kind: string; n: number }>(`SELECT a.kind, count(*)::int AS n FROM audit_log a JOIN repositories r ON r.id = a.repo_id WHERE ${scope.sql} GROUP BY a.kind ORDER BY a.kind`, scope.params)
    res.json({ entries: rows.rows.map(auditDto), kinds: kinds.rows })
  }),
)

const verifyBody = z.object({ repoId: z.string().optional() }).strict()

auditRouter.post(
  '/audit/verify',
  asyncHandler(async (req, res) => {
    const user = userOf(req)
    const { repoId } = verifyBody.parse(req.body ?? {})
    let repos: RepoRow[]
    if (repoId) {
      const repo = await loadRepo(pool, repoId)
      if (!repo || !canAccessOrg(user, repo.org_id)) throw notFound('Repository')
      repos = [repo]
    } else {
      const scope = orgFilter(user)
      repos = (await pool.query<RepoRow>(`SELECT r.* FROM repositories r WHERE ${scope.sql} ORDER BY r.full_name`, scope.params)).rows
    }
    const chains = []
    for (const r of repos) chains.push({ repoId: r.id, repo: r.full_name, ...(await verifyChain(pool, r.id)) })
    res.json({ ok: chains.every((c) => c.ok), chains })
  }),
)
