/**
 * Sign-in, sign-out and the current user with every org they can open.
 */
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { z } from 'zod'
import { createSession, destroySession, listAccess, requireAuth, sessionCookieOptions, type SessionUser } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'

export const authRouter = Router()

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) })

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body)
    const { rows } = await pool.query<{ id: string; username: string; password_hash: string; display_name: string; is_staff: boolean }>(
      'SELECT id, username, password_hash, display_name, is_staff FROM users WHERE username = $1',
      [username],
    )
    const row = rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }
    const user: SessionUser = { id: String(row.id), username: row.username, displayName: row.display_name, isStaff: row.is_staff }
    const sessionId = await createSession(user)
    res.cookie(config.sessionCookie, sessionId, sessionCookieOptions())
    res.json({ user, orgs: await listAccess(user) })
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

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user, orgs: await listAccess(req.user!) })
  }),
)
