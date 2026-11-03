import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { z } from 'zod'
import {
  createSession,
  destroySession,
  requireAuth,
  sessionCookieOptions,
  type SessionUser,
} from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { enforceRateLimit } from '../../shared/rate-limit.js'

export const authRouter = Router()

const loginSchema = z
  .object({
    email: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(200),
  })
  .strict()

/** The orgs a user belongs to, for the org switcher. Roles here are display only. */
export async function listUserOrgs(userId: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.plan, o.branding, m.role
       FROM org_memberships m
       JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1
      ORDER BY o.name`,
    [userId],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, plan: r.plan, branding: r.branding, role: r.role }))
}

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    await enforceRateLimit(`login:${req.ip}`, 20, 60)
    const { email, password } = loginSchema.parse(req.body)
    const { rows } = await pool.query(
      'SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = lower($1)',
      [email],
    )
    const row = rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')
    }
    const user: SessionUser = { id: row.id, email: row.email, displayName: row.display_name }
    const sessionId = await createSession(user)
    res.cookie(config.sessionCookie, sessionId, sessionCookieOptions())
    res.json({ user, orgs: await listUserOrgs(user.id) })
  }),
)

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.sessionId) await destroySession(req.sessionId, req.user?.id)
    res.clearCookie(config.sessionCookie, { path: '/' })
    res.status(204).end()
  }),
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { preview: _preview, ...user } = req.user!
    res.json({ user, orgs: await listUserOrgs(user.id) })
  }),
)
