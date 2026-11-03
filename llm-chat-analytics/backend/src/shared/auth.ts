/**
 * Session authentication (opaque session ID in an httpOnly cookie, session data
 * in Valkey) and per-org access. Roles are re-read from PostgreSQL on every
 * request, so a demotion takes effect on the next call, including for cached
 * query results (the cache key carries the permission scope).
 * @module shared/auth
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { pool } from './db.js'
import { HttpError } from './errors.js'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  isStaff: boolean
}

export type Role = 'admin' | 'analyst' | 'support'
export type Permission = 'metrics:read' | 'billing:read' | 'drilldown:read' | 'export:create'

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['metrics:read', 'billing:read', 'drilldown:read', 'export:create'],
  analyst: ['metrics:read', 'drilldown:read', 'export:create'],
  // Internal support staff can see any org's health, but not its spend or its conversations.
  support: ['metrics:read'],
}

export interface OrgAccess {
  orgId: string
  orgName: string
  timeZone: string
  role: Role
  permissions: Permission[]
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
    try {
      const raw = await redis.get(keys.session(id))
      if (raw) {
        req.user = JSON.parse(raw) as SessionUser
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

/** Every org the user can open, with the role and permissions they hold there. */
export async function listAccess(user: SessionUser): Promise<OrgAccess[]> {
  if (user.isStaff) {
    const { rows } = await pool.query<{ id: string; name: string; time_zone: string }>(
      'SELECT id, name, time_zone FROM orgs ORDER BY name',
    )
    return rows.map((r) => ({ orgId: r.id, orgName: r.name, timeZone: r.time_zone, role: 'support', permissions: ROLE_PERMISSIONS.support }))
  }
  const { rows } = await pool.query<{ id: string; name: string; time_zone: string; role: 'admin' | 'analyst' }>(
    `SELECT o.id, o.name, o.time_zone, m.role
       FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY o.name`,
    [user.id],
  )
  return rows.map((r) => ({ orgId: r.id, orgName: r.name, timeZone: r.time_zone, role: r.role, permissions: ROLE_PERMISSIONS[r.role] }))
}

export async function requireOrgAccess(user: SessionUser, orgId: string, permission: Permission = 'metrics:read'): Promise<OrgAccess> {
  const access = (await listAccess(user)).find((a) => a.orgId === orgId)
  // 404 rather than 403 for orgs the user is not in: don't confirm that they exist.
  if (!access) throw new HttpError(404, 'ORG_NOT_FOUND', 'No such organization')
  if (!access.permissions.includes(permission)) {
    throw new HttpError(403, 'FORBIDDEN', `Your role (${access.role}) does not include ${permission}`)
  }
  return access
}
