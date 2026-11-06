/**
 * Session authentication: an opaque session id in an httpOnly cookie, session data in Valkey.
 * Three roles: shippers (see only their own cars), network operations (see everything, act on
 * exceptions and plans) and platform admins (operations plus the streams, DLQ redrive and replay pages).
 *
 * Access is enforced at the read model: every shipper query filters by the session's shipper id, which
 * each projection row carries (denormalized from the trip plan when the row is written).
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'shipper' | 'ops' | 'admin'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  shipperId: string | null
  shipperName: string | null
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      sessionId?: string
    }
  }
}

const sessionKey = (id: string) => `tp:session:${id}`

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

/** The shipper filter for a query: a shipper id for shipper sessions, null (no filter) for internal roles. */
export function shipperScope(user: SessionUser): string | null {
  return user.role === 'shipper' ? user.shipperId : null
}

/** True when this user may see a row owned by `shipperId`. */
export function canSeeShipper(user: SessionUser, shipperId: string | null): boolean {
  if (user.role !== 'shipper') return true
  return shipperId !== null && shipperId === user.shipperId
}

/** Producers authenticate with a shared ingest token (per-producer mTLS in production). */
export function requireIngestToken(req: Request, _res: Response, next: NextFunction): void {
  if (req.get('x-ingest-token') !== config.ingestToken) {
    next(new HttpError(401, 'BAD_INGEST_TOKEN', 'Missing or invalid X-Ingest-Token'))
    return
  }
  next()
}

/** Either a producer token or an ops/admin session (the simulator plays the yard system with a token). */
export async function requireIngestOrOps(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.get('x-ingest-token') === config.ingestToken) {
    next()
    return
  }
  requireRole('ops')(req, res, next)
}
