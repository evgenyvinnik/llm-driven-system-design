/**
 * Session authentication: an opaque id in an httpOnly cookie, session data in
 * Valkey.
 *
 * The session also carries a snapshot of the user's group ids ("claims"),
 * refreshed when older than CLAIMS_TTL_SECONDS, like the groups claim of an
 * ID token. Retrieval uses the claims only for the index pre-filter, where a
 * stale claim costs nothing but a wasted candidate; the re-check reads
 * `group_members` live, so removing someone from a group takes effect on
 * their very next question regardless of what their session says.
 *
 * Roles: `member` and `org_admin` (also manages groups) belong to one org;
 * `operator` is platform staff and sees pipeline health, never content.
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { pool } from './db.js'
import { HttpError } from './errors.js'

export type Role = 'member' | 'org_admin' | 'operator'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  orgId: string | null
  orgName: string | null
  /** Group ids at `claimsAt` (ms). A pre-filter hint only, never an access decision. */
  groupIds: string[]
  claimsAt: number
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      sessionId?: string
    }
  }
}

export async function loadGroupIds(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ group_id: string }>(`SELECT group_id FROM group_members WHERE user_id = $1 ORDER BY group_id`, [userId])
  return rows.map((r) => r.group_id)
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

/** Attaches req.user when a valid session cookie is present; refreshes stale group claims. Never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.cookies?.[config.sessionCookie]
    if (typeof id === 'string' && id.length > 0) {
      const user = await loadSession(id)
      if (user) {
        if (user.role !== 'operator' && Date.now() - (user.claimsAt ?? 0) > config.claimsTtlSeconds * 1000) {
          user.groupIds = await loadGroupIds(user.id)
          user.claimsAt = Date.now()
          await redis.set(keys.session(id), JSON.stringify(user), 'KEEPTTL')
        }
        req.user = user
        req.sessionId = id
      }
    }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  next()
}

/** A member of an org (member or org_admin): everything below is scoped to that org. */
export function requireMember(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (req.user.role === 'operator' || !req.user.orgId) return next(new HttpError(403, 'FORBIDDEN', 'Organization members only'))
  next()
}

export function requireOrgAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (req.user.role !== 'org_admin') return next(new HttpError(403, 'FORBIDDEN', 'Organization admins only'))
  next()
}

export function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (req.user.role !== 'operator') return next(new HttpError(403, 'FORBIDDEN', 'Operators only'))
  next()
}

/** The member's org and user ids, for a request that passed requireMember. */
export function principal(req: Request): { orgId: string; userId: string; user: SessionUser } {
  const user = req.user
  if (!user?.orgId) throw new HttpError(403, 'FORBIDDEN', 'Organization members only')
  return { orgId: user.orgId, userId: user.id, user }
}
