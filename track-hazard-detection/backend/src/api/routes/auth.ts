import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { z } from 'zod'
import { createSession, destroySession, requireAuth, sessionCookieOptions, type Role, type SessionUser } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { enforceRateLimit } from '../../shared/rate-limit.js'

export const authRouter = Router()

const loginSchema = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }).strict()

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    await enforceRateLimit(`login:${req.ip}`, 20, 60)
    const { username, password } = loginSchema.parse(req.body)
    const { rows } = await pool.query<{ id: string; username: string; display_name: string; role: Role; desk_id: string | null; password_hash: string }>(
      'SELECT id, username, display_name, role, desk_id, password_hash FROM users WHERE username = $1',
      [username.toLowerCase()],
    )
    const row = rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }
    const user: SessionUser = { id: row.id, username: row.username, displayName: row.display_name, role: row.role, deskId: row.desk_id }
    res.cookie(config.sessionCookie, await createSession(user), sessionCookieOptions())
    res.json({ user })
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
  res.json({ user: req.user })
})
