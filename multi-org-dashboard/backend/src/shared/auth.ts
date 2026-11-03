/**
 * Session authentication: an opaque session ID in an httpOnly cookie, session
 * data in Valkey. A session identifies the user only. It never carries a role
 * or an org, so no authorization decision can come from a stale session.
 *
 * Each user's session IDs are indexed (usess:{userId}) so that removing a
 * user from their last org can end every session they have.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { redis } from './cache.js'
import { HttpError } from './errors.js'
import type { Role } from './permissions.js'

export interface SessionUser {
  id: string
  email: string
  displayName: string
  /** An admin previewing one org as another role. Read-only; see shared/org-access. */
  preview?: { orgId: string; role: Role }
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
const userSessionsKey = (userId: string) => `usess:${userId}`

export async function createSession(user: SessionUser): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await redis
    .multi()
    .set(sessionKey(id), JSON.stringify(user), 'EX', config.sessionTtlSeconds)
    .sadd(userSessionsKey(user.id), id)
    .expire(userSessionsKey(user.id), config.sessionTtlSeconds)
    .exec()
  return id
}

export async function updateSession(id: string, user: SessionUser): Promise<void> {
  await redis.set(sessionKey(id), JSON.stringify(user), 'KEEPTTL')
}

export async function destroySession(id: string, userId?: string): Promise<void> {
  await redis.del(sessionKey(id))
  if (userId) await redis.srem(userSessionsKey(userId), id)
}

/** Ends every session a user has. Open event streams notice on their next heartbeat or event. */
export async function destroyAllSessions(userId: string): Promise<number> {
  const ids = await redis.smembers(userSessionsKey(userId))
  if (ids.length > 0) await redis.del(...ids.map(sessionKey))
  await redis.del(userSessionsKey(userId))
  return ids.length
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
    next(new HttpError(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in to continue.'))
    return
  }
  next()
}
