/**
 * Controls and their Azure Policy effect (prevention), the audit log, notifications,
 * and admin operations against the scanner and the cloud simulator.
 */
import { Router } from 'express'
import { z } from 'zod'
import { CONTROLS, getControl } from '../../domain/controls.js'
import { HttpControlPlane } from '../../arm/http-client.js'
import { ownerScope, requireAuth, requireRole } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { audit } from '../../store/audit.js'
import { computePosture } from '../../store/posture.js'

export const controlsRouter = Router()
export const auditRouter = Router()
export const notificationsRouter = Router()
export const adminRouter = Router()

const sim = new HttpControlPlane(config.simUrl, 'remediation-api')
/** Below this compliance, a deny assignment would reject routine redeploys of existing accounts. */
export const DENY_READY_PCT = 95

controlsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const [{ rows }, posture] = await Promise.all([pool.query('SELECT * FROM controls ORDER BY id'), computePosture(pool)])
    res.json({
      controls: CONTROLS.map((c) => {
        const row = rows.find((r) => r.id === c.id)
        const p = posture.find((x) => x.controlId === c.id)
        return {
          id: c.id,
          key: c.key,
          version: c.version,
          title: c.title,
          description: c.description,
          severity: c.severity,
          kind: c.kind,
          breaking: c.breaking,
          property: c.property,
          desired: c.desiredLabel,
          policyDefinition: c.policy.definition,
          allowedEffects: c.policy.effects,
          policyEffect: row?.policy_effect ?? 'audit',
          policyUpdatedAt: row?.policy_updated_at ?? null,
          policyUpdatedBy: row?.policy_updated_by ?? null,
          compliancePct: p?.compliancePct ?? 0,
          open: p?.open ?? 0,
          denyReadyPct: DENY_READY_PCT,
        }
      }),
    })
  }),
)

controlsRouter.put(
  '/:id/policy',
  requireRole('security'),
  asyncHandler(async (req, res) => {
    const control = getControl(req.params.id)
    const { effect, force } = z.object({ effect: z.enum(['audit', 'deny', 'modify', 'deployIfNotExists', 'auditIfNotExists']), force: z.boolean().optional() }).strict().parse(req.body)
    if (!control.policy.effects.includes(effect)) throw new HttpError(422, 'EFFECT_NOT_SUPPORTED', `${control.id} supports: ${control.policy.effects.join(', ')}`)
    if (effect === 'deny' && !force) {
      const p = (await computePosture(pool)).find((x) => x.controlId === control.id)
      if (p && p.compliancePct < DENY_READY_PCT) {
        throw new HttpError(409, 'BURN_DOWN_INCOMPLETE', `${control.id} is ${p.compliancePct}% compliant. Deny would reject redeploys of the ${p.open} non-compliant accounts and block rollbacks; burn down to ${DENY_READY_PCT}% first or pass force.`, { compliancePct: p.compliancePct, open: p.open })
      }
    }
    const pushed = await sim.setPolicy(control.id, effect === 'audit' || effect === 'auditIfNotExists' ? null : effect)
    if (pushed.status !== 200) throw new HttpError(502, 'POLICY_ASSIGNMENT_FAILED', `Policy assignment failed with HTTP ${pushed.status}`)
    const user = req.user!
    await withTransaction(async (c) => {
      const { rows } = await c.query<{ policy_effect: string }>('SELECT policy_effect FROM controls WHERE id = $1 FOR UPDATE', [control.id])
      await c.query('UPDATE controls SET policy_effect = $2, policy_updated_at = now(), policy_updated_by = $3 WHERE id = $1', [control.id, effect, user.username])
      await audit(c, { actor: `user:${user.username}`, action: 'policy.changed', controlId: control.id, before: rows[0]?.policy_effect ?? null, after: effect, details: { forced: Boolean(force) } })
    })
    res.json({ controlId: control.id, effect })
  }),
)

auditRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = z
      .object({ account: z.string().optional(), campaign: z.string().optional(), action: z.string().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query)
    const params: unknown[] = []
    const where: string[] = []
    if (req.user!.role === 'owner') where.push(`(l.account_id IS NOT NULL AND ${ownerScope(req.user!, 'a', params)})`)
    const add = (sql: (p: string) => string, v: unknown) => {
      params.push(v)
      where.push(sql(`$${params.length}`))
    }
    if (q.account) add((p) => `a.name = ${p}`, q.account)
    if (q.campaign) add((p) => `l.campaign_id = ${p}`, q.campaign)
    if (q.action) add((p) => `l.action LIKE ${p}`, `${q.action}%`)
    if (q.before) add((p) => `l.id < ${p}`, q.before)
    params.push(q.limit)
    const { rows } = await pool.query(
      `SELECT l.*, a.name AS account_name FROM audit_log l LEFT JOIN storage_accounts a ON a.id = l.account_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT $${params.length}`,
      params,
    )
    res.json({
      entries: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, accountId: r.account_id, accountName: r.account_name, controlId: r.control_id, campaignId: r.campaign_id, before: r.before, after: r.after, details: r.details })),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1].id : null,
    })
  }),
)

notificationsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { rows } =
      user.role === 'owner'
        ? await pool.query(`SELECT * FROM notifications WHERE audience = 'owner' AND team = $1 ORDER BY created_at DESC LIMIT 50`, [user.team])
        : await pool.query(`SELECT * FROM notifications WHERE audience = $1 ORDER BY created_at DESC LIMIT 50`, [user.role])
    res.json({ notifications: rows.map((n) => ({ id: n.id, kind: n.kind, message: n.message, accountId: n.account_id, controlId: n.control_id, dueAt: n.due_at, createdAt: n.created_at, readAt: n.read_at })) })
  }),
)

adminRouter.post(
  '/scan',
  requireRole('security'),
  asyncHandler(async (req, res) => {
    const { kind } = z.object({ kind: z.enum(['full-scan', 'evidence']).default('full-scan') }).parse(req.body ?? {})
    const receivers = await redis.publish('scanner:commands', kind)
    res.status(202).json({ requested: kind, scanners: receivers })
  }),
)

async function simFetch(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`${config.simUrl}${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

adminRouter.get(
  '/sim',
  requireRole('security'),
  asyncHandler(async (_req, res) => {
    const r = await simFetch('/admin/state')
    res.status(r.status).json(r.body)
  }),
)

adminRouter.put(
  '/sim/faults',
  requireRole('security'),
  asyncHandler(async (req, res) => {
    const r = await simFetch('/admin/faults', 'PUT', req.body)
    res.status(r.status).json(r.body)
  }),
)

adminRouter.post(
  '/sim/drift',
  requireRole('security'),
  asyncHandler(async (req, res) => {
    const r = await simFetch('/admin/drift', 'POST', req.body)
    res.status(r.status).json(r.body)
  }),
)
