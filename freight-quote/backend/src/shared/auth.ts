/**
 * Authentication. People sign in with a session (opaque id in an httpOnly
 * cookie, data in Valkey). Customer integrations authenticate with an API
 * key, stored as a SHA-256 hash. Three roles: customer users (one customer's
 * quotes only), ops (the operations page, knobs, streams) and admin (also
 * publishes tariffs and fuel surcharges).
 * @module shared/auth
 */
import { createHash, randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { redis } from './cache.js'
import { pool } from './db.js'
import { HttpError } from './errors.js'

export type Role = 'customer' | 'ops' | 'admin'

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: Role
  customerId: string | null
  customerName: string | null
}

export interface ApiClient {
  customerId: string
  customerName: string
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      sessionId?: string
      apiClient?: ApiClient
    }
  }
}

const sessionKey = (id: string) => `fq:session:${id}`

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex')

export async function createSession(user: SessionUser): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await redis.set(sessionKey(id), JSON.stringify(user), 'EX', config.sessionTtlSeconds)
  return id
}

export async function destroySession(id: string): Promise<void> {
  await redis.del(sessionKey(id))
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

const apiKeyCache = new Map<string, { client: ApiClient | null; at: number }>()

async function lookupApiKey(key: string): Promise<ApiClient | null> {
  const hash = hashApiKey(key)
  const hit = apiKeyCache.get(hash)
  if (hit && Date.now() - hit.at < 30_000) return hit.client
  const { rows } = await pool.query<{ id: string; name: string }>('SELECT id, name FROM customers WHERE api_key_hash = $1', [hash])
  const client = rows[0] ? { customerId: rows[0].id, customerName: rows[0].name } : null
  apiKeyCache.set(hash, { client, at: Date.now() })
  return client
}

/** Attaches req.user (session cookie) or req.apiClient (X-Api-Key). Rejects only a bad API key. */
export async function attachPrincipal(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = req.get('x-api-key')
    if (apiKey) {
      const client = await lookupApiKey(apiKey)
      if (!client) {
        next(new HttpError(401, 'BAD_API_KEY', 'Unknown API key'))
        return
      }
      req.apiClient = client
      next()
      return
    }
    const id = req.cookies?.[config.sessionCookie]
    if (typeof id === 'string' && id.length > 0) {
      const raw = await redis.get(sessionKey(id))
      if (raw) {
        req.user = JSON.parse(raw) as SessionUser
        req.sessionId = id
      }
    }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user && !req.apiClient) {
    next(new HttpError(401, 'UNAUTHENTICATED', 'Sign in or send X-Api-Key'))
    return
  }
  next()
}

/** Session roles only; admins pass every check. */
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

/** The customer a request acts for: the API key's customer, or a customer user's own customer. Ops/admin act for none. */
export function actingCustomer(req: Request): string | null {
  if (req.apiClient) return req.apiClient.customerId
  if (req.user?.role === 'customer') return req.user.customerId
  return null
}

export function isStaff(req: Request): boolean {
  return req.user?.role === 'ops' || req.user?.role === 'admin'
}

/** A quote, booking or delivery is visible to its own customer and to staff, never to another customer. */
export function canSeeCustomer(req: Request, customerId: string): boolean {
  return isStaff(req) || actingCustomer(req) === customerId
}
