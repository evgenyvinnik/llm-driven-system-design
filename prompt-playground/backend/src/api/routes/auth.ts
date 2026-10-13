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

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
})

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    await enforceRateLimit(`login:${req.ip}`, 20, 60)
    const { username, password } = loginSchema.parse(req.body)
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.password_hash, u.role, m.workspace_id, w.name AS workspace_name
         FROM users u
         JOIN workspace_members m ON m.user_id = u.id
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE u.username = $1
        ORDER BY m.joined_at
        LIMIT 1`,
      [username.toLowerCase()],
    )
    const row = rows[0]
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid username or password')
    }
    const user: SessionUser = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      workspaceId: row.workspace_id,
    }
    const sessionId = await createSession(user)
    res.cookie(config.sessionCookie, sessionId, sessionCookieOptions())
    res.json({ user: { ...user, workspaceName: row.workspace_name } })
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
    const { rows } = await pool.query('SELECT name FROM workspaces WHERE id = $1', [req.user!.workspaceId])
    res.json({ user: { ...req.user, workspaceName: rows[0]?.name ?? '' } })
  }),
)
