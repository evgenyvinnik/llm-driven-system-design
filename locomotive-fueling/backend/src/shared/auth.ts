/**
 * Session authentication (opaque id in an httpOnly cookie, session data in
 * Valkey) and role checks. Roles:
 * - fuel_desk: the dispatcher who owns fuel plans and DTL orders
 * - crew: read-only view of the one train they are assigned to
 * - admin: everything the fuel desk can do, plus prices and model parameters
 * @module shared/auth
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'fuel_desk' | 'crew' | 'admin'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  /** Crew only: the train symbol id they may see. */
  trainId: string | null
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

/** Crew may only read their own train; everyone else may read any train. */
export function canSeeTrain(user: SessionUser, trainId: string): boolean {
  return user.role !== 'crew' || user.trainId === trainId
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Shared-token check for machine callers (onboard units, integrations). */
export function requireToken(header: string, expected: () => string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const got = req.get(header)
    if (!got || !safeEqual(got, expected())) {
      next(new HttpError(401, 'BAD_TOKEN', `Missing or invalid ${header}`))
      return
    }
    next()
  }
}
