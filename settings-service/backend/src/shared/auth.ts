/**
 * Session authentication (opaque id in an httpOnly cookie, session data in
 * Valkey) and role checks. Roles:
 * - member: reads and writes their own settings
 * - org_admin: also sets their organization's policy (defaults, enforcement)
 * - platform_admin: also manages the global catalog of setting definitions
 *
 * Every settings endpoint takes the user and org from the session, never from
 * the URL, so there is no id to tamper with.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'member' | 'org_admin' | 'platform_admin'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  orgId: string
  orgName: string
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      sessionId?: string
    }
  }
}

export async function createSession(user: SessionUser): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await redis.set(keys.session(id), JSON.stringify(user), 'EX', config.sessionTtlSeconds)
  return id
}

export async function destroySession(id: string): Promise<void> {
  await redis.del(keys.session(id))
}

export async function loadSession(id: string): Promise<SessionUser | null> {
  const raw = await redis.get(keys.session(id))
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
    const user = await loadSession(id)
    if (user) {
      req.user = user
      req.sessionId = id
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

const RANK: Record<Role, number> = { member: 0, org_admin: 1, platform_admin: 2 }

/** Allows the given role and anything above it. */
export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.user?.role
    if (!role) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
      return
    }
    if (RANK[role] < RANK[min]) {
      next(new HttpError(403, 'FORBIDDEN', 'Your role cannot do this'))
      return
    }
    next()
  }
}
