/**
 * Session authentication (opaque id in an httpOnly cookie, session data in
 * Valkey) and role checks. Roles:
 * - yardmaster: owns the plan; edits, locks, publishes, resolves conflicts
 * - crew: sees the published list; reports execution from a handheld
 * - admin: everything a yardmaster can do, plus simulator controls and replay runs
 * @module shared/auth
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'yardmaster' | 'crew' | 'admin'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
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

/** Allows only the listed roles. Admin is always allowed. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.user?.role
    if (!role) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
      return
    }
    if (role !== 'admin' && !roles.includes(role)) {
      next(new HttpError(403, 'FORBIDDEN', 'Your role cannot do this'))
      return
    }
    next()
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Shared-token check for machine callers (simulator, external hold feed). */
export function requireIntegrationToken(req: Request, _res: Response, next: NextFunction): void {
  const got = req.get('x-integration-token')
  if (!got || !safeEqual(got, config.integrationToken)) {
    next(new HttpError(401, 'BAD_TOKEN', 'Missing or invalid X-Integration-Token'))
    return
  }
  next()
}

/** Either a signed-in person with the role, or a machine with the token (acts as `sim`). */
export function requireRoleOrToken(...roles: Role[]) {
  const roleCheck = requireRole(...roles)
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.get('x-integration-token')) {
      requireIntegrationToken(req, res, (err?: unknown) => {
        if (err) return next(err)
        req.user = { id: 'u_sim', username: req.get('x-acting-as') || 'sim', displayName: 'Simulator', role: 'admin' }
        next()
      })
      return
    }
    roleCheck(req, res, next)
  }
}
