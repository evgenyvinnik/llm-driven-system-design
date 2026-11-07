/**
 * Who is calling: an API key (public API) or a console member acting with one
 * of their org's keys. Both resolve to the same principal, so console traffic
 * goes through exactly the same admission, queues and limits as API traffic.
 * Keys are looked up by SHA-256 hash and cached for 30 s per gateway instance
 * (revocation takes effect within that window).
 * @module gateway/principal
 */
import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { pool } from '../shared/db.js'
import { ApiError } from '../shared/errors.js'

export interface Principal {
  keyId: string
  keyName: string
  orgId: string
  orgSlug: string
  orgName: string
  tier: string
  tokensPerMinute: number
  requestsPerMinute: number
  maxQueuedInteractive: number
  maxQueuedBatch: number
  weight: number
}

interface PrincipalRow {
  key_id: string
  key_name: string
  org_id: string
  slug: string
  org_name: string
  tier: string
  tokens_per_minute: number
  requests_per_minute: number
  max_queued_interactive: number
  max_queued_batch: number
  weight: number
}

const SELECT = `
  SELECT k.id AS key_id, k.name AS key_name, o.id AS org_id, o.slug, o.name AS org_name, o.tier,
         t.tokens_per_minute, t.requests_per_minute, t.max_queued_interactive, t.max_queued_batch, t.weight
  FROM api_keys k JOIN orgs o ON o.id = k.org_id JOIN tiers t ON t.name = o.tier
  WHERE k.revoked_at IS NULL`

function toPrincipal(r: PrincipalRow): Principal {
  return {
    keyId: r.key_id,
    keyName: r.key_name,
    orgId: r.org_id,
    orgSlug: r.slug,
    orgName: r.org_name,
    tier: r.tier,
    tokensPerMinute: r.tokens_per_minute,
    requestsPerMinute: r.requests_per_minute,
    maxQueuedInteractive: r.max_queued_interactive,
    maxQueuedBatch: r.max_queued_batch,
    weight: r.weight,
  }
}

export function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

const cache = new Map<string, { p: Principal; at: number }>()
const TTL_MS = 30_000

export function clearPrincipalCache(): void {
  cache.clear()
}

export async function principalFromSecret(secret: string): Promise<Principal | null> {
  const h = hashKey(secret)
  const hit = cache.get(h)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p
  const { rows } = await pool.query<PrincipalRow>(`${SELECT} AND k.key_hash = $1`, [h])
  if (!rows[0]) return null
  const p = toPrincipal(rows[0])
  cache.set(h, { p, at: Date.now() })
  void pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [p.keyId]).catch(() => undefined)
  return p
}

/** Console: a key id the signed-in user may use (their org's, or any for an admin). */
export async function principalForMember(keyId: string, userId: string, isAdmin: boolean): Promise<Principal> {
  const { rows } = await pool.query<PrincipalRow>(
    `${SELECT} AND k.id::text = $1 AND ($3 OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.user_id = $2))`,
    [keyId, userId, isAdmin],
  )
  if (!rows[0]) throw new ApiError(403, 'permission_error', 'You cannot use this API key')
  return toPrincipal(rows[0])
}

export function secretFromRequest(req: Request): string | null {
  const header = req.get('x-api-key')
  if (header) return header.trim()
  const auth = req.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  return null
}

export async function requirePrincipal(req: Request): Promise<Principal> {
  const secret = secretFromRequest(req)
  if (!secret) throw new ApiError(401, 'authentication_error', 'Missing x-api-key header')
  const p = await principalFromSecret(secret)
  if (!p) throw new ApiError(401, 'authentication_error', 'Invalid API key')
  return p
}
