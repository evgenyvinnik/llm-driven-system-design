/**
 * Console session authentication (opaque id in an httpOnly cookie, session data
 * in Valkey). The public API uses API keys instead (gateway/principal.ts).
 * - members see and use their orgs' keys and requests;
 * - admins (platform operators) also see queues, batches, backends and usage.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { ApiError } from './errors.js'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
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
    next(new ApiError(401, 'authentication_error', 'Sign in to continue'))
    return
  }
  next()
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new ApiError(401, 'authentication_error', 'Sign in to continue'))
    return
  }
  if (!req.user.isAdmin) {
    next(new ApiError(403, 'permission_error', 'Admins only'))
    return
  }
  next()
}
