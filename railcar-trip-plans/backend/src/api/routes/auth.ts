import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { z } from 'zod'
import { createSession, destroySession, requireAuth, sessionCookieOptions, type SessionUser } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'

export const authRouter = Router()

const Login = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) })

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = Login.parse(req.body)
    const { rows } = await pool.query<{ id: string; username: string; password_hash: string; display_name: string; role: SessionUser['role']; shipper_id: string | null; shipper_name: string | null }>(
      `SELECT u.id, u.username, u.password_hash, u.display_name, u.role, u.shipper_id, s.name AS shipper_name
         FROM users u LEFT JOIN shippers s USING (shipper_id) WHERE u.username = $1`,
      [username],
    )
    const row = rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    const user: SessionUser = { id: row.id, username: row.username, displayName: row.display_name, role: row.role, shipperId: row.shipper_id, shipperName: row.shipper_name }
    const sessionId = await createSession(user)
    res.cookie(config.sessionCookie, sessionId, sessionCookieOptions())
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
