/**
 * Session authentication: an opaque id in an httpOnly cookie, session data in
 * Valkey. Access to repositories is decided per request by shared/access.ts.
 * Runners never see a session: they authenticate with their own bearer token.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { HttpError } from './errors.js'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  orgId: string
  orgName: string
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
    const raw = await redis.get(keys.session(id)).catch(() => null)
    if (raw) {
      req.user = JSON.parse(raw) as SessionUser
      req.sessionId = id
    }
  }
  next()
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  next()
}

export function userOf(req: Request): SessionUser {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue')
  return req.user
}
