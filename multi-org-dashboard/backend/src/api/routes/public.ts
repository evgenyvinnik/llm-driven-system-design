/**
 * Token-addressed routes outside any org path: viewing and accepting an
 * invitation, and opening a shared prompt by link. Tokens are looked up by
 * hash and never cached, so a revocation is effective on the next request.
 */
import { Router } from 'express'
import { announceAuthzChange, bumpAuthzVersion } from '../../shared/access.js'
import { writeAudit } from '../../shared/audit.js'
import { requireAuth } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { publishUserEvent } from '../../shared/events.js'
import { hashToken, tokenParam } from '../../shared/ids.js'
import type { Role } from '../../shared/permissions.js'

export const publicRouter = Router()

function invitationState(r: { accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }) {
  if (r.accepted_at) return 'accepted'
  if (r.revoked_at) return 'revoked'
  if (r.expires_at.getTime() <= Date.now()) return 'expired'
  return 'pending'
}

publicRouter.get(
  '/invitations/:token',
  asyncHandler(async (req, res) => {
    const token = tokenParam(req.params.token, 'Invitation')
    const { rows } = await pool.query(
      `SELECT i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, o.name AS org_name, u.display_name AS invited_by_name
         FROM invitations i JOIN orgs o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = $1`,
      [hashToken(token)],
    )
    const inv = rows[0]
    if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Invitation not found')
    res.json({
      invitation: {
        orgName: inv.org_name,
        role: inv.role,
        email: inv.email,
        invitedByName: inv.invited_by_name,
        expiresAt: inv.expires_at,
        status: invitationState(inv),
      },
    })
  }),
)

publicRouter.post(
  '/invitations/:token/accept',
  requireAuth,
  asyncHandler(async (req, res) => {
    const token = tokenParam(req.params.token, 'Invitation')
    const user = req.user!
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT i.id, i.org_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, o.name AS org_name
           FROM invitations i JOIN orgs o ON o.id = i.org_id
          WHERE i.token_hash = $1 FOR UPDATE OF i`,
        [hashToken(token)],
      )
      const inv = rows[0]
      if (!inv) throw new HttpError(404, 'NOT_FOUND', 'Invitation not found')
      const state = invitationState(inv)
      if (state !== 'pending') throw new HttpError(410, `INVITATION_${state.toUpperCase()}`, `This invitation is ${state}`)
      // The token alone isn't enough: a forwarded invitation must not let someone else in.
      if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
        throw new HttpError(403, 'INVITATION_EMAIL_MISMATCH', `This invitation is for ${inv.email}. Sign in with that account.`)
      }
      const inserted = await client.query(
        `INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO NOTHING RETURNING role`,
        [inv.org_id, user.id, inv.role],
      )
      await client.query('UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, user.id])
      const version = inserted.rowCount ? await bumpAuthzVersion(client, inv.org_id) : null
      await writeAudit(client, {
        orgId: inv.org_id,
        actor: user,
        action: 'invitation.accepted',
        targetType: 'invitation',
        targetId: inv.id,
        targetName: inv.email,
        after: { role: inv.role, alreadyMember: !inserted.rowCount },
      })
      return { orgId: inv.org_id as string, orgName: inv.org_name as string, role: inv.role as Role, version }
    })
    if (result.version) {
      await announceAuthzChange(result.orgId, result.version, 'member_added')
      await publishUserEvent(user.id, {
        type: 'membership.added',
        orgId: result.orgId,
        orgName: result.orgName,
        role: result.role,
      })
    }
    res.json({ orgId: result.orgId, orgName: result.orgName, role: result.role, alreadyMember: !result.version })
  }),
)

/**
 * A shared prompt, readable without signing in. Unknown tokens are 404;
 * revoked or expired ones are 410 so the page can say so. The link also dies
 * if its creator has left the org, even if revoking it on removal had failed.
 */
publicRouter.get(
  '/shared/:token',
  asyncHandler(async (req, res) => {
    const token = tokenParam(req.params.token, 'Link')
    const { rows } = await pool.query(
      `SELECT l.id, l.expires_at, l.revoked_at, p.title, p.body, p.updated_at, o.name AS org_name,
              u.display_name AS owner_name,
              EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = l.org_id AND m.user_id = l.created_by) AS creator_is_member
         FROM share_links l
         JOIN prompts p ON p.id = l.resource_id AND p.org_id = l.org_id
         JOIN orgs o ON o.id = l.org_id
         LEFT JOIN users u ON u.id = p.owner_id
        WHERE l.token_hash = $1 AND l.resource_type = 'prompt'`,
      [hashToken(token)],
    )
    const link = rows[0]
    if (!link) throw new HttpError(404, 'NOT_FOUND', 'This link does not exist')
    if (link.revoked_at || !link.creator_is_member) throw new HttpError(410, 'LINK_REVOKED', 'This link was revoked')
    if (link.expires_at && link.expires_at <= new Date()) throw new HttpError(410, 'LINK_EXPIRED', 'This link has expired')
    await pool.query('UPDATE share_links SET last_used_at = now() WHERE id = $1', [link.id])
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      prompt: {
        title: link.title,
        body: link.body,
        updatedAt: link.updated_at,
        orgName: link.org_name,
        ownerName: link.owner_name,
        expiresAt: link.expires_at,
      },
    })
  }),
)
