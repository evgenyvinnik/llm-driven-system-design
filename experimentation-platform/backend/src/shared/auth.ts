/**
 * Session authentication for the admin console (opaque id in an httpOnly
 * cookie, session data in Valkey) and role checks.
 *
 * Roles:
 * - admin: edits flags and experiments, changes status, pulls the kill switch
 * - viewer: reads everything (lists, configs, audit, results, live clients), changes nothing
 * - shopper: a demo-storefront account; cannot use the console at all
 *
 * The storefront has its own cookie (shop_session), so being signed in to the
 * shop never grants console access.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'admin' | 'viewer' | 'shopper'

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

/** Attaches req.user when a valid console session cookie is present. Never rejects. */
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

/** Console reads: admin or viewer. */
export function requireConsole(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (req.user.role !== 'admin' && req.user.role !== 'viewer') return next(new HttpError(403, 'FORBIDDEN', 'This account cannot use the console'))
  next()
}

/** Console writes: admin only. Checked on the server for every mutation, not just hidden in the UI. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (req.user.role !== 'admin') return next(new HttpError(403, 'FORBIDDEN', 'Viewers can read but not change flags or experiments'))
  next()
}
