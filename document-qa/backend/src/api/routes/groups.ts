/**
 * Groups and membership. Removing someone from a group touches only
 * `group_members`: no index rows change (they carry the group id, not member
 * lists) and the user's session claims are left as they are. The very next
 * question still drops that group's documents, because the re-check reads
 * membership live. That is the point of the demo.
 * @module api/routes/groups
 */
import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { principal, requireMember, requireOrgAdmin } from '../../shared/auth.js'

export const groupsRouter = Router()
groupsRouter.use(requireMember)

groupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { orgId } = principal(req)
    const [groups, members, users] = await Promise.all([
      pool.query<{ id: string; name: string; doc_count: number }>(
        `SELECT g.id, g.name, (SELECT count(*)::int FROM documents d WHERE d.group_id = g.id AND d.scope = 'group' AND d.deleted_at IS NULL) AS doc_count
           FROM groups g WHERE g.org_id = $1 ORDER BY g.name`,
        [orgId],
      ),
      pool.query<{ group_id: string; user_id: string; display_name: string; username: string; added_at: Date }>(
        `SELECT gm.group_id, gm.user_id, u.display_name, u.username, gm.added_at FROM group_members gm JOIN users u ON u.id = gm.user_id
          JOIN groups g ON g.id = gm.group_id WHERE g.org_id = $1 ORDER BY u.display_name`,
        [orgId],
      ),
      pool.query<{ id: string; display_name: string; username: string; role: string }>(
        `SELECT id, display_name, username, role FROM users WHERE org_id = $1 AND active ORDER BY display_name`,
        [orgId],
      ),
    ])
    res.json({
      groups: groups.rows.map((g) => ({
        id: g.id,
        name: g.name,
        documentCount: g.doc_count,
        members: members.rows
          .filter((m) => m.group_id === g.id)
          .map((m) => ({ userId: m.user_id, displayName: m.display_name, username: m.username, addedAt: m.added_at.toISOString() })),
      })),
      users: users.rows.map((u) => ({ id: u.id, displayName: u.display_name, username: u.username, role: u.role })),
    })
  }),
)

async function groupInOrg(groupId: string, orgId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT 1 FROM groups WHERE id = $1 AND org_id = $2`, [groupId, orgId])
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Group not found')
}

groupsRouter.post(
  '/:id/members',
  requireOrgAdmin,
  asyncHandler(async (req, res) => {
    const { orgId } = principal(req)
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body)
    await groupInOrg(req.params.id, orgId)
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE id = $1 AND org_id = $2`, [userId, orgId])
    if (!rows[0]) throw new HttpError(422, 'UNKNOWN_USER', 'That user is not in your organization')
    await pool.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.params.id, userId])
    res.status(201).json({ ok: true })
  }),
)

groupsRouter.delete(
  '/:id/members/:userId',
  requireOrgAdmin,
  asyncHandler(async (req, res) => {
    const { orgId } = principal(req)
    await groupInOrg(req.params.id, orgId)
    const { rowCount } = await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [req.params.id, req.params.userId])
    res.json({ removed: rowCount ?? 0 })
  }),
)
