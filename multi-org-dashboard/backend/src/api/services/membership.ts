/**
 * Membership changes. Each one runs in a single transaction that also bumps
 * the org's authz version and writes the audit event; notifications go out
 * only after commit, so nobody is told about a change that rolled back.
 */
import { announceAuthzChange, bumpAuthzVersion } from '../../shared/access.js'
import { writeAudit } from '../../shared/audit.js'
import { destroyAllSessions } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { publishUserEvent } from '../../shared/events.js'
import { logger } from '../../shared/logger.js'
import type { Role } from '../../shared/permissions.js'
import type pg from 'pg'

interface Actor {
  id: string
  displayName: string
}

/** Locks every admin row so two concurrent demotions can't both pass the "last admin" check. */
async function assertNotLastAdmin(client: pg.PoolClient, orgId: string, userId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT user_id FROM org_memberships WHERE org_id = $1 AND role = 'admin' FOR UPDATE`,
    [orgId],
  )
  if (rows.length <= 1 && rows.some((r) => r.user_id === userId)) {
    throw new HttpError(409, 'LAST_ADMIN', 'An organization needs at least one admin')
  }
}

export async function changeRole(orgId: string, orgName: string, userId: string, role: Role, actor: Actor) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.role, u.display_name FROM org_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
      [orgId, userId],
    )
    const member = rows[0]
    if (!member) return null
    if (member.role === role) return { from: role as Role, to: role, version: null }
    if (member.role === 'admin') await assertNotLastAdmin(client, orgId, userId)
    await client.query('UPDATE org_memberships SET role = $3 WHERE org_id = $1 AND user_id = $2', [orgId, userId, role])
    const version = await bumpAuthzVersion(client, orgId)
    await writeAudit(client, {
      orgId,
      actor,
      action: 'member.role_changed',
      targetType: 'user',
      targetId: userId,
      targetName: member.display_name,
      before: { role: member.role },
      after: { role },
    })
    return { from: member.role as Role, to: role, version }
  })
  if (result?.version) {
    await announceAuthzChange(orgId, result.version, 'role_changed')
    await publishUserEvent(userId, { type: 'role.changed', orgId, orgName, from: result.from, to: result.to })
  }
  return result
}

export interface RemovalResult {
  invitationsRevoked: number
  linksRevoked: number
  exportsCancelled: number
  sessionsEnded: number
}

/**
 * Removing a member takes away everything that could outlive the membership:
 * invitations they sent (or that would re-add them), share links they
 * created, exports they started, and, if this was their last org, every
 * session. Their open event streams are told immediately.
 */
export async function removeMember(orgId: string, orgName: string, userId: string, actor: Actor) {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT m.role, u.display_name, u.email FROM org_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
      [orgId, userId],
    )
    const member = rows[0]
    if (!member) return null
    if (member.role === 'admin') await assertNotLastAdmin(client, orgId, userId)

    await client.query('DELETE FROM org_memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId])
    await client.query(
      `DELETE FROM project_memberships WHERE user_id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $1)`,
      [orgId, userId],
    )
    const invitations = await client.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          AND (invited_by = $2 OR lower(email) = lower($3))`,
      [orgId, userId, member.email],
    )
    const links = await client.query(
      `UPDATE share_links SET revoked_at = now(), revoked_by = $3
        WHERE org_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
      [orgId, userId, actor.id],
    )
    const exports = await client.query(
      `UPDATE export_jobs
          SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
              error_code = CASE WHEN status = 'queued' THEN 'ACCESS_REVOKED' ELSE error_code END,
              cancel_requested_at = now()
        WHERE org_id = $1 AND created_by = $2 AND status IN ('queued', 'running')`,
      [orgId, userId],
    )
    const version = await bumpAuthzVersion(client, orgId)
    const counts = {
      invitationsRevoked: invitations.rowCount ?? 0,
      linksRevoked: links.rowCount ?? 0,
      exportsCancelled: exports.rowCount ?? 0,
    }
    await writeAudit(client, {
      orgId,
      actor,
      action: 'member.removed',
      targetType: 'user',
      targetId: userId,
      targetName: member.display_name,
      before: { role: member.role },
      after: counts,
    })
    return { ...counts, version }
  })
  if (!result) return null

  await announceAuthzChange(orgId, result.version, 'member_removed')
  await publishUserEvent(userId, { type: 'access.revoked', orgId, orgName, reason: 'removed' })

  let sessionsEnded = 0
  const remaining = await pool.query('SELECT 1 FROM org_memberships WHERE user_id = $1 LIMIT 1', [userId])
  if (!remaining.rowCount) {
    try {
      sessionsEnded = await destroyAllSessions(userId)
      await publishUserEvent(userId, { type: 'session.revoked', reason: 'no_memberships' })
    } catch (err) {
      // Not fatal: requests are authorized per org, so a leftover session can't reach this org anyway.
      logger.warn({ err: (err as Error).message, userId }, 'ending sessions failed')
    }
  }
  const { version: _version, ...counts } = result
  return { ...counts, sessionsEnded } satisfies RemovalResult
}
