/**
 * Settings: members, invitations, share links, audit log, feature flags and
 * billing. Every mutation is audited in its own transaction.
 */
import { z } from 'zod'
import { announceAuthzChange, bumpAuthzVersion } from '../../shared/access.js'
import { writeAudit } from '../../shared/audit.js'
import { config } from '../../shared/config.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { hashToken, newToken, uuidParam } from '../../shared/ids.js'
import { accessOf, orgRoutes } from '../../shared/org-access.js'
import { ROLES } from '../../shared/permissions.js'
import { changeRole, removeMember } from '../services/membership.js'

export const adminRouter = orgRoutes()

adminRouter.get(
  '/members',
  { permission: 'members.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name, u.email, m.role, m.created_at
         FROM org_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1
        ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.display_name`,
      [access.orgId],
    )
    res.json({
      members: rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        // Emails are personal data; editors see names and roles only.
        email: access.permissions.includes('members.manage') ? r.email : undefined,
        role: r.role,
        joinedAt: r.created_at,
        isYou: r.id === access.userId,
      })),
    })
  }),
)

const roleSchema = z.object({ role: z.enum(ROLES) }).strict()

adminRouter.patch(
  '/members/:userId',
  { permission: 'members.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const userId = uuidParam(req.params.userId, 'Member')
    const { role } = roleSchema.parse(req.body)
    const result = await changeRole(access.orgId, access.orgName, userId, role, req.user!)
    if (!result) throw notFound('Member')
    res.json({ member: { id: userId, role: result.to }, previousRole: result.from })
  }),
)

adminRouter.delete(
  '/members/:userId',
  { permission: 'members.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const userId = uuidParam(req.params.userId, 'Member')
    const result = await removeMember(access.orgId, access.orgName, userId, req.user!)
    if (!result) throw notFound('Member')
    res.json({ removed: true, ...result })
  }),
)

function invitationStatus(r: { accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }) {
  if (r.accepted_at) return 'accepted'
  if (r.revoked_at) return 'revoked'
  if (r.expires_at.getTime() <= Date.now()) return 'expired'
  return 'pending'
}

adminRouter.get(
  '/invitations',
  { permission: 'members.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, u.display_name AS invited_by_name
         FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.org_id = $1
        ORDER BY i.created_at DESC
        LIMIT 100`,
      [access.orgId],
    )
    res.json({
      invitations: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        status: invitationStatus(r),
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        invitedByName: r.invited_by_name,
      })),
    })
  }),
)

const inviteSchema = z.object({ email: z.string().trim().email().max(200), role: z.enum(ROLES) }).strict()

adminRouter.post(
  '/invitations',
  { permission: 'members.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { email, role } = inviteSchema.parse(req.body)
    const token = newToken()
    const invitation = await withTransaction(async (client) => {
      // Seats are an entitlement: pending invitations count, so the limit can't be passed by inviting in bulk.
      // Locking the org row serializes concurrent invitations for the seat count.
      await client.query('SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE', [access.orgId])
      const { rows: seats } = await client.query(
        `SELECT (SELECT count(*) FROM org_memberships WHERE org_id = $1)
              + (SELECT count(*) FROM invitations WHERE org_id = $1 AND accepted_at IS NULL
                   AND revoked_at IS NULL AND expires_at > now()) AS used`,
        [access.orgId],
      )
      if (Number(seats[0].used) >= access.entitlements.seats) {
        throw new HttpError(403, 'ENTITLEMENT_REQUIRED', `The ${access.plan} plan includes ${access.entitlements.seats} seats`, {
          entitlement: 'seats',
          plan: access.plan,
        })
      }
      const existing = await client.query(
        `SELECT 1 FROM org_memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND lower(u.email) = lower($2)`,
        [access.orgId, email],
      )
      if (existing.rowCount) throw new HttpError(409, 'ALREADY_MEMBER', `${email} is already a member`)
      const { rows } = await client.query(
        `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
         RETURNING id, expires_at`,
        [access.orgId, email, role, hashToken(token), access.userId, config.invitationTtlDays],
      )
      await writeAudit(client, {
        orgId: access.orgId,
        actor: req.user!,
        action: 'invitation.created',
        targetType: 'invitation',
        targetId: rows[0].id,
        targetName: email,
        after: { role, expiresAt: rows[0].expires_at },
      })
      return rows[0]
    })
    // The token is shown once, so the admin can send it; only the hash is stored.
    res.status(201).json({
      invitation: { id: invitation.id, email, role, expiresAt: invitation.expires_at, acceptUrl: `/invite/${token}` },
    })
  }),
)

adminRouter.delete(
  '/invitations/:invitationId',
  { permission: 'members.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.invitationId, 'Invitation')
    const revoked = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE invitations SET revoked_at = now()
          WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING email, role`,
        [id, access.orgId],
      )
      if (!rows[0]) return false
      await writeAudit(client, {
        orgId: access.orgId,
        actor: req.user!,
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetId: id,
        targetName: rows[0].email,
        before: { role: rows[0].role },
      })
      return true
    })
    if (!revoked) throw notFound('Pending invitation')
    res.status(204).end()
  }),
)

adminRouter.get(
  '/links',
  { permission: 'links.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `SELECT l.id, l.resource_type, l.resource_id, p.title AS resource_title, l.token_hint, l.expires_at,
              l.revoked_at, l.last_used_at, l.created_at, u.display_name AS created_by_name
         FROM share_links l
         LEFT JOIN prompts p ON p.id = l.resource_id AND p.org_id = l.org_id
         LEFT JOIN users u ON u.id = l.created_by
        WHERE l.org_id = $1
        ORDER BY l.revoked_at IS NOT NULL, l.created_at DESC
        LIMIT 200`,
      [access.orgId],
    )
    res.json({
      links: rows.map((r) => ({
        id: r.id,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        resourceTitle: r.resource_title,
        tokenHint: r.token_hint,
        status: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at <= new Date() ? 'expired' : 'active',
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
        createdByName: r.created_by_name,
      })),
    })
  }),
)

/**
 * Revoking a link: its creator, or anyone who manages links. No feature flag
 * here, on purpose: turning the prompt library off must not stop anyone
 * from revoking what was already shared.
 */
adminRouter.delete(
  '/links/:linkId',
  { permission: 'prompts.share' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.linkId, 'Link')
    const canManage = access.permissions.includes('links.manage')
    const revoked = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT l.created_by, l.revoked_at, p.title FROM share_links l
           LEFT JOIN prompts p ON p.id = l.resource_id
          WHERE l.id = $1 AND l.org_id = $2 FOR UPDATE OF l`,
        [id, access.orgId],
      )
      const link = rows[0]
      if (!link || (!canManage && link.created_by !== access.userId)) return null
      if (link.revoked_at) return true
      await client.query('UPDATE share_links SET revoked_at = now(), revoked_by = $2 WHERE id = $1', [id, access.userId])
      await writeAudit(client, {
        orgId: access.orgId,
        actor: req.user!,
        action: 'link.revoked',
        targetType: 'share_link',
        targetId: id,
        targetName: link.title,
      })
      return true
    })
    if (!revoked) throw notFound('Link')
    res.status(204).end()
  }),
)

const auditQuerySchema = z.object({
  action: z.string().regex(/^[a-z_]+(\.[a-z_]+)?$/).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

adminRouter.get(
  '/audit',
  { permission: 'audit.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { action, before, limit } = auditQuerySchema.parse(req.query)
    const params: unknown[] = [access.orgId, access.entitlements.auditRetentionDays]
    let where = `e.org_id = $1 AND e.created_at >= now() - make_interval(days => $2)`
    if (action) {
      params.push(action.includes('.') ? action : `${action}.%`)
      where += action.includes('.') ? ` AND e.action = $${params.length}` : ` AND e.action LIKE $${params.length}`
    }
    if (before) {
      params.push(before)
      where += ` AND e.id < $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT e.id, e.actor_name, e.action, e.target_type, e.target_id, e.target_name, e.before, e.after, e.created_at
         FROM audit_events e WHERE ${where} ORDER BY e.id DESC LIMIT ${limit + 1}`,
      params,
    )
    const page = rows.slice(0, limit)
    res.json({
      events: page.map((r) => ({
        id: String(r.id),
        actorName: r.actor_name,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        targetName: r.target_name,
        before: r.before,
        after: r.after,
        createdAt: r.created_at,
      })),
      nextBefore: rows.length > limit ? String(page[page.length - 1].id) : null,
      retentionDays: access.entitlements.auditRetentionDays,
    })
  }),
)

adminRouter.get(
  '/features',
  { permission: 'features.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `SELECT f.key, f.description, f.default_enabled, r.enabled, r.roles, r.updated_at
         FROM feature_flags f LEFT JOIN feature_flag_rules r ON r.flag_key = f.key AND r.org_id = $1
        ORDER BY f.key`,
      [access.orgId],
    )
    res.json({
      flags: rows.map((r) => ({
        key: r.key,
        description: r.description,
        defaultEnabled: r.default_enabled,
        rule: r.enabled === null ? null : { enabled: r.enabled, roles: r.roles, updatedAt: r.updated_at },
      })),
    })
  }),
)

const flagRuleSchema = z.object({ enabled: z.boolean(), roles: z.array(z.enum(ROLES)).max(ROLES.length) }).strict()

adminRouter.put(
  '/features/:flagKey',
  { permission: 'features.manage' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const key = String(req.params.flagKey)
    const rule = flagRuleSchema.parse(req.body)
    const roles = [...new Set(rule.roles)].sort()
    const version = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT f.key, r.enabled, r.roles FROM feature_flags f
           LEFT JOIN feature_flag_rules r ON r.flag_key = f.key AND r.org_id = $2
          WHERE f.key = $1`,
        [key, access.orgId],
      )
      if (!rows[0]) return null
      await client.query(
        `INSERT INTO feature_flag_rules (flag_key, org_id, enabled, roles, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (flag_key, org_id) DO UPDATE SET enabled = EXCLUDED.enabled, roles = EXCLUDED.roles, updated_at = now()`,
        [key, access.orgId, rule.enabled, roles],
      )
      const next = await bumpAuthzVersion(client, access.orgId)
      await writeAudit(client, {
        orgId: access.orgId,
        actor: req.user!,
        action: 'flag.changed',
        targetType: 'feature_flag',
        targetId: key,
        targetName: key,
        before: rows[0].enabled === null ? null : { enabled: rows[0].enabled, roles: rows[0].roles },
        after: { enabled: rule.enabled, roles },
      })
      return next
    })
    if (version === null) throw notFound('Feature flag')
    await announceAuthzChange(access.orgId, version, 'flag_changed')
    res.json({ flag: { key, rule: { enabled: rule.enabled, roles } } })
  }),
)

adminRouter.get(
  '/billing',
  { permission: 'billing.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM org_memberships WHERE org_id = $1)::int AS members,
         (SELECT count(*) FROM invitations WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
            AND expires_at > now())::int AS pending_invitations,
         (SELECT count(*) FROM conversations WHERE org_id = $1 AND started_at >= date_trunc('month', now()))::int AS conversations_mtd,
         (SELECT coalesce(sum(cost_cents), 0) FROM conversations WHERE org_id = $1
            AND started_at >= date_trunc('month', now()))::int AS cost_mtd_cents`,
      [access.orgId],
    )
    const usage = rows[0]
    const monthly = access.plan === 'pro' ? 49_900 : 9_900
    // Synthetic invoice history: the console shows billing; it doesn't run it.
    const invoices = [1, 2, 3].map((monthsAgo) => {
      const d = new Date()
      d.setUTCDate(1)
      d.setUTCMonth(d.getUTCMonth() - monthsAgo)
      return {
        id: `inv_${access.orgId.slice(4, 10)}_${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        period: d.toISOString().slice(0, 7),
        amountCents: monthly + monthsAgo * 1_250,
        status: 'paid',
      }
    })
    res.json({
      plan: access.plan,
      entitlements: access.entitlements,
      seats: { used: usage.members + usage.pending_invitations, members: usage.members, limit: access.entitlements.seats },
      usage: { conversationsMonthToDate: usage.conversations_mtd, costMonthToDateCents: usage.cost_mtd_cents },
      invoices,
    })
  }),
)
