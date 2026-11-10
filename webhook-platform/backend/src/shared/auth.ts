/**
 * Session authentication (opaque id in an httpOnly cookie, session data in
 * Valkey) for people, and API keys for producers.
 *
 * Roles:
 * - customer: a member of one org; sees and manages only that org's endpoints,
 *   events, deliveries and notifications.
 * - operator: platform staff; sees fleet-wide health (queue depth, in-flight
 *   per endpoint, success rate) but no customer payloads.
 *
 * API keys are 192-bit random strings, so a plain SHA-256 is safe to store and
 * index (unlike passwords, they can't be guessed from a dictionary).
 * @module shared/auth
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { pool } from './db.js'
import { HttpError } from './errors.js'

export type Role = 'customer' | 'operator'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  orgId: string | null
  orgName: string | null
}

/** Who is acting on a request: a signed-in person or a producer API key. */
export interface Principal {
  orgId: string
  via: 'session' | 'api_key'
  userId: string | null
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      sessionId?: string
      principal?: Principal
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

/** A customer session: the org every query below is scoped to. */
export function requireCustomer(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (req.user.role !== 'customer' || !req.user.orgId) return next(new HttpError(403, 'FORBIDDEN', 'Customer accounts only'))
  next()
}

export function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue'))
  if (req.user.role !== 'operator') return next(new HttpError(403, 'FORBIDDEN', 'Operators only'))
  next()
}

/** Customer org id for a request that passed requireCustomer. */
export function orgOf(req: Request): string {
  const orgId = req.user?.orgId
  if (!orgId) throw new HttpError(403, 'FORBIDDEN', 'Customer accounts only')
  return orgId
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Producer auth: `Authorization: Bearer whk_...` resolves to an org; a
 * customer session works too (the console's "send test event").
 */
export async function requireProducer(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization')
  if (header?.startsWith('Bearer ')) {
    const { rows } = await pool.query<{ id: string; org_id: string; stale: boolean }>(
      `SELECT id, org_id, (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') AS stale
         FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hashApiKey(header.slice(7).trim())],
    )
    if (!rows[0]) return next(new HttpError(401, 'BAD_API_KEY', 'Unknown or revoked API key'))
    // "Last used" is refreshed at most once a minute: a write per emit was 1 of every 8 row writes per delivery.
    if (rows[0].stale) void pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [rows[0].id]).catch(() => undefined)
    req.principal = { orgId: rows[0].org_id, via: 'api_key', userId: null }
    return next()
  }
  if (req.user?.role === 'customer' && req.user.orgId) {
    req.principal = { orgId: req.user.orgId, via: 'session', userId: req.user.id }
    return next()
  }
  next(new HttpError(401, 'UNAUTHENTICATED', 'Send an API key (Authorization: Bearer whk_...) or sign in'))
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Shared-token check for internal callers (the mock receiver). */
export function requireInternal(req: Request, _res: Response, next: NextFunction): void {
  const got = req.get('x-internal-token')
  if (!got || !safeEqual(got, config.internalToken)) return next(new HttpError(401, 'BAD_TOKEN', 'Missing or invalid X-Internal-Token'))
  next()
}
