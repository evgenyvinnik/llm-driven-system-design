/**
 * Findings explorer: filterable, paginated, scoped to the caller's team for owners.
 */
import { Router } from 'express'
import { z } from 'zod'
import { CONTROLS, getControl } from '../../domain/controls.js'
import { ownerScope, requireAuth } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'

export const findingsRouter = Router()

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))

const querySchema = z.object({
  control: csv,
  subscription: csv,
  owner: csv,
  severity: csv,
  evidence: csv,
  environment: csv,
  status: z.enum(['open', 'exempt', 'resolved', 'all']).default('open'),
  q: z.string().max(100).optional(),
  sort: z.enum(['risk', 'due', 'first_seen']).default('risk'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

findingsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = querySchema.parse(req.query)
    const params: unknown[] = []
    const where: string[] = ['a.deleted_at IS NULL', ownerScope(req.user!, 'a', params)]
    const add = (sql: (p: string) => string, value: unknown) => {
      params.push(value)
      where.push(sql(`$${params.length}`))
    }
    if (q.status !== 'all') add((p) => `f.status = ${p}`, q.status)
    if (q.control) add((p) => `f.control_id = ANY(${p})`, q.control)
    if (q.subscription) add((p) => `a.subscription_id = ANY(${p})`, q.subscription)
    if (q.owner) add((p) => `COALESCE(a.owner, '(none)') = ANY(${p})`, q.owner)
    if (q.severity) add((p) => `f.severity = ANY(${p})`, q.severity)
    if (q.evidence) add((p) => `f.evidence_class = ANY(${p})`, q.evidence)
    if (q.environment) add((p) => `a.environment = ANY(${p})`, q.environment)
    if (q.q) add((p) => `a.name ILIKE ${p}`, `%${q.q}%`)
    const order = q.sort === 'due' ? 'f.due_at ASC NULLS LAST' : q.sort === 'first_seen' ? 'f.first_seen_at ASC' : 'f.risk_score DESC, f.due_at ASC'
    const whereSql = where.join(' AND ')
    const countParams = [...params]
    params.push(q.pageSize, (q.page - 1) * q.pageSize)
    const [rows, total] = await Promise.all([
      pool.query(
        `SELECT f.id, f.account_id, a.name AS account_name, a.subscription_id, s.display_name AS subscription_name, a.environment, a.owner, a.owner_source,
                a.data_classification, f.control_id, f.severity, f.risk_score, f.status, f.evidence_class, f.evidence_reason, f.observed,
                f.first_seen_at, f.due_at, f.reopened_count,
                EXISTS (SELECT 1 FROM campaign_targets t JOIN campaigns c ON c.id = t.campaign_id
                         WHERE t.account_id = f.account_id AND c.control_id = f.control_id AND t.state IN ('queued', 'applying', 'baking', 'rolling_back')) AS in_remediation
           FROM findings f JOIN storage_accounts a ON a.id = f.account_id LEFT JOIN subscriptions s ON s.subscription_id = a.subscription_id
          WHERE ${whereSql} ORDER BY ${order}, f.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      ),
      pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM findings f JOIN storage_accounts a ON a.id = f.account_id WHERE ${whereSql}`, countParams),
    ])
    res.json({
      findings: rows.rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        accountName: r.account_name,
        subscriptionId: r.subscription_id,
        subscriptionName: r.subscription_name,
        environment: r.environment,
        owner: r.owner,
        ownerSource: r.owner_source,
        dataClassification: r.data_classification,
        controlId: r.control_id,
        controlTitle: getControl(r.control_id).title,
        severity: r.severity,
        riskScore: r.risk_score,
        status: r.status,
        evidenceClass: r.evidence_class,
        evidenceReason: r.evidence_reason,
        observed: r.observed,
        firstSeenAt: r.first_seen_at,
        dueAt: r.due_at,
        reopenedCount: r.reopened_count,
        inRemediation: r.in_remediation,
      })),
      total: total.rows[0].n,
      page: q.page,
      pageSize: q.pageSize,
    })
  }),
)

findingsRouter.get(
  '/facets',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params: unknown[] = []
    const scope = ownerScope(req.user!, 'a', params)
    const [subs, owners, envs] = await Promise.all([
      pool.query<{ subscription_id: string; display_name: string }>(
        `SELECT DISTINCT s.subscription_id, s.display_name FROM subscriptions s JOIN storage_accounts a ON a.subscription_id = s.subscription_id
          WHERE a.deleted_at IS NULL AND ${scope} ORDER BY s.display_name`,
        params,
      ),
      pool.query<{ owner: string }>(`SELECT DISTINCT COALESCE(a.owner, '(none)') AS owner FROM storage_accounts a WHERE a.deleted_at IS NULL AND ${scope} ORDER BY 1`, params),
      pool.query<{ environment: string }>(`SELECT DISTINCT a.environment FROM storage_accounts a WHERE a.deleted_at IS NULL AND ${scope} ORDER BY 1`, params),
    ])
    res.json({
      controls: CONTROLS.map((c) => ({ id: c.id, title: c.title })),
      subscriptions: subs.rows.map((s) => ({ id: s.subscription_id, name: s.display_name })),
      owners: owners.rows.map((o) => o.owner),
      environments: envs.rows.map((e) => e.environment),
    })
  }),
)
