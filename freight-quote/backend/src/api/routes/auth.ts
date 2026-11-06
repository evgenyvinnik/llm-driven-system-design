import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { createSession, destroySession, sessionCookieOptions, type SessionUser } from '../../shared/auth.js'

export const authRouter = Router()

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body)
    const { rows } = await pool.query(
      `SELECT u.*, c.name AS customer_name FROM users u LEFT JOIN customers c ON c.id = u.customer_id WHERE u.username = $1`,
      [username.toLowerCase()],
    )
    const row = rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    const user: SessionUser = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      customerId: row.customer_id,
      customerName: row.customer_name,
    }
    const id = await createSession(user)
    res.cookie(config.sessionCookie, id, sessionCookieOptions())
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

authRouter.get('/me', (req, res) => {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in')
  res.json({ user: req.user })
})
