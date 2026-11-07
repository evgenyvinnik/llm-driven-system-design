import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { createSession, destroySession, loadGroupIds, requireAuth, sessionCookieOptions, type Role, type SessionUser } from '../../shared/auth.js'

export const authRouter = Router()

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) })

function publicUser(u: SessionUser) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, orgId: u.orgId, orgName: u.orgName, groupIds: u.groupIds }
}

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body)
    const { rows } = await pool.query<{
      id: string
      username: string
      display_name: string
      password_hash: string
      role: Role
      org_id: string | null
      org_name: string | null
      active: boolean
    }>(
      `SELECT u.id, u.username, u.display_name, u.password_hash, u.role, u.org_id, o.name AS org_name, u.active
         FROM users u LEFT JOIN orgs o ON o.id = u.org_id WHERE u.username = $1`,
      [username.toLowerCase()],
    )
    const row = rows[0]
    if (!row || !row.active || !(await bcrypt.compare(password, row.password_hash))) throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid username or password')
    const user: SessionUser = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      orgId: row.org_id,
      orgName: row.org_name,
      groupIds: row.role === 'operator' ? [] : await loadGroupIds(row.id),
      claimsAt: Date.now(),
    }
    const sid = await createSession(user)
    res.cookie(config.sessionCookie, sid, sessionCookieOptions())
    res.json({ user: publicUser(user) })
  }),
)

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.sessionId) await destroySession(req.sessionId)
    res.clearCookie(config.sessionCookie, { path: '/' })
    res.status(204).end()
  }),
)

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user as SessionUser) })
})
