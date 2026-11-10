/**
 * Console sign-in. Passwords are bcrypt hashes; sessions live in Valkey.
 * @module gateway/routes/auth
 */
import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { z } from 'zod'
import { createSession, destroySession, requireAuth, sessionCookieOptions, type SessionUser } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { ApiError, asyncHandler } from '../../shared/errors.js'

export const authRouter = Router()

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256) })

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = loginSchema.parse(req.body)
    const { rows } = await pool.query<{ id: string; username: string; display_name: string; password_hash: string; is_admin: boolean }>(
      'SELECT id, username, display_name, password_hash, is_admin FROM users WHERE username = $1',
      [username.trim().toLowerCase()],
    )
    const row = rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) throw new ApiError(401, 'authentication_error', 'Invalid username or password')
    const user: SessionUser = { id: row.id, username: row.username, displayName: row.display_name, isAdmin: row.is_admin }
    const sid = await createSession(user)
    res.cookie(config.sessionCookie, sid, sessionCookieOptions())
    res.json({ user })
  }),
)

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.sessionId) await destroySession(req.sessionId)
    res.clearCookie(config.sessionCookie, { path: '/' })
    res.json({ ok: true })
  }),
)

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})
