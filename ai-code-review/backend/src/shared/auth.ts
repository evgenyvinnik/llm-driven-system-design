/**
 * Session authentication: an opaque id in an httpOnly cookie, session data in
 * Valkey. Each user belongs to one org and every query is scoped to it; the
 * platform admin (org NULL) sees all orgs. Workers and the poster never see a
 * session: they act on rows that already carry a repository.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { HttpError } from './errors.js'

export type Role = 'reviewer' | 'repo_admin' | 'admin'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  orgId: string | null
  orgName: string | null
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

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: config.sessionTtlSeconds * 1000,
    path: '/',
  }
}

export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.cookies?.[config.sessionCookie]
  if (typeof id === 'string' && id.length > 0) {
    const raw = await redis.get(keys.session(id))
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

/** Repository settings, modes and fixtures. */
export function requireRepoAdmin(req: Request, _res: Response, next: NextFunction): void {
  const u = req.user
  if (!u) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (u.role !== 'repo_admin' && u.role !== 'admin') return next(new HttpError(403, 'FORBIDDEN', 'Repo admin role required'))
  next()
}

/** True when this user's org owns a row in that org. Cross-org access reads as "not found". */
export function canAccessOrg(user: SessionUser, orgId: string): boolean {
  return user.role === 'admin' || user.orgId === orgId
}
