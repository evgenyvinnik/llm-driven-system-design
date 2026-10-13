/**
 * Session authentication (opaque session ID in an httpOnly cookie, session data
 * in Valkey) and workspace authorization helpers.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { redis } from './cache.js'
import { pool } from './db.js'
import { HttpError } from './errors.js'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: 'user' | 'admin'
  workspaceId: string
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      sessionId?: string
    }
  }
}

const sessionKey = (id: string) => `session:${id}`

export async function createSession(user: SessionUser): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await redis.set(sessionKey(id), JSON.stringify(user), 'EX', config.sessionTtlSeconds)
  return id
}

export async function destroySession(id: string): Promise<void> {
  await redis.del(sessionKey(id))
}

export async function loadSession(id: string): Promise<SessionUser | null> {
  const raw = await redis.get(sessionKey(id))
  return raw ? (JSON.parse(raw) as SessionUser) : null
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: config.sessionTtlSeconds * 1000,
    path: '/',
  }
}

/** Attaches req.user when a valid session cookie is present. Never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.cookies?.[config.sessionCookie]
  if (typeof id === 'string' && id.length > 0) {
    try {
      const user = await loadSession(id)
      if (user) {
        req.user = user
        req.sessionId = id
      }
    } catch (err) {
      next(err)
      return
    }
  }
  next()
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
    return
  }
  next()
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new HttpError(403, 'FORBIDDEN', 'Admin access required'))
    return
  }
  next()
}

/**
 * Authorization is checked against PostgreSQL on every request, not cached in
 * the session, so removing a member takes effect on their next call.
 */
export async function assertWorkspaceMember(userId: string, workspaceId: string): Promise<void> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  )
  if (!rowCount) throw new HttpError(403, 'NOT_A_MEMBER', 'You are no longer a member of this workspace')
}

/**
 * For routes that act on the session's workspace (listing prompts, presets):
 * the session only remembers which workspace was chosen, so membership is
 * re-checked here rather than trusted from the session.
 */
export async function requireWorkspaceMember(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
    return
  }
  try {
    await assertWorkspaceMember(req.user.id, req.user.workspaceId)
    next()
  } catch (err) {
    next(err)
  }
}
