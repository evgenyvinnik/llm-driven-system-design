/**
 * Session authentication: an opaque session ID in an httpOnly cookie, session
 * data in Valkey. Three roles: dispatchers (a desk that covers subdivisions),
 * yard car inspectors (one yard) and reliability engineers (admin).
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'dispatcher' | 'yard' | 'admin'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  deskId: string | null
  yardId: string | null
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

/** Admins pass every role check. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
      return
    }
    if (req.user.role !== 'admin' && !roles.includes(req.user.role)) {
      next(new HttpError(403, 'FORBIDDEN', `Requires role: ${roles.join(' or ')}`))
      return
    }
    next()
  }
}

/** Yard inspectors act only on their own yard; dispatchers and admins on any. */
export function canActOnYard(user: SessionUser, yardId: string | null): boolean {
  if (user.role === 'admin') return true
  if (user.role === 'yard') return yardId !== null && user.yardId === yardId
  return false
}

/** Gateways authenticate with a shared ingest token (per-gateway mTLS in production). */
export function requireIngestToken(req: Request, _res: Response, next: NextFunction): void {
  if (req.get('x-ingest-token') !== config.ingestToken) {
    next(new HttpError(401, 'BAD_INGEST_TOKEN', 'Missing or invalid X-Ingest-Token'))
    return
  }
  next()
}
