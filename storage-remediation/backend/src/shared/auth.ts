/**
 * Session authentication: an opaque session ID in an httpOnly cookie, session
 * data in Valkey. Three roles:
 * - security: runs campaigns, changes controls and policy effects, sees everything
 * - owner: sees accounts owned by their team, fixes them or requests exceptions
 * - approver: sees everything read-only, approves or rejects exceptions
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'security' | 'owner' | 'approver'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  /** Owning team for resource owners (matches the `owner` tag on accounts). */
  team: string | null
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

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
      return
    }
    if (!roles.includes(req.user.role)) {
      next(new HttpError(403, 'FORBIDDEN', `Requires role: ${roles.join(' or ')}`))
      return
    }
    next()
  }
}

/**
 * The owner scope as a SQL fragment. Owners see only accounts tagged with their
 * team; the filter is part of every query, never applied after the fact.
 * `alias` is the storage_accounts alias in the caller's query.
 */
export function ownerScope(user: SessionUser, alias: string, params: unknown[]): string {
  if (user.role !== 'owner') return 'TRUE'
  params.push(user.team ?? '__none__')
  return `${alias}.owner = $${params.length}`
}
