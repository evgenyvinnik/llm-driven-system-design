/**
 * Identity aliasing: what happens when an anonymous visitor signs in.
 *
 * Policy: the first anonymous id a user signs in from becomes their stable id
 * (first link wins, INSERT … ON CONFLICT DO NOTHING). `user` experiments bucket
 * by the stable id, so
 *   - the visitor keeps the variant they were already seeing when they sign in
 *     (no flip mid-funnel, and conversions after sign-in attribute to the
 *     pre-sign-in exposure);
 *   - every later device converges on the same bucket after sign-in.
 * A later device's own anonymous id is recorded in identity_links; its
 * pre-sign-in exposures are a different unit, and if they were in a different
 * variant the analysis sees a crossover and leaves the unit out.
 * @module services/identity-service
 */
import { keys, redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'

export interface LinkResult {
  stableId: string
  /** True when this sign-in created the alias (the user's first). */
  created: boolean
}

export async function linkIdentity(environment: string, userId: string, anonymousId: string): Promise<LinkResult> {
  await pool.query('INSERT INTO identity_links (environment, anonymous_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [environment, anonymousId, userId])
  const inserted = await pool.query<{ stable_id: string }>(
    'INSERT INTO identity_aliases (environment, user_id, stable_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING stable_id',
    [environment, userId, anonymousId],
  )
  let stableId = inserted.rows[0]?.stable_id
  const created = Boolean(stableId)
  if (!stableId) {
    const existing = await pool.query<{ stable_id: string }>('SELECT stable_id FROM identity_aliases WHERE environment = $1 AND user_id = $2', [environment, userId])
    stableId = existing.rows[0].stable_id
  }
  await redis.set(keys.alias(environment, userId), stableId, 'EX', 3600).catch(() => undefined)
  return { stableId, created }
}

/** The user's stable id, or null when they have never signed in through the SDK. */
export async function resolveStableId(environment: string, userId: string): Promise<string | null> {
  const cached = await redis.get(keys.alias(environment, userId)).catch(() => null)
  if (cached) return cached
  const { rows } = await pool.query<{ stable_id: string }>('SELECT stable_id FROM identity_aliases WHERE environment = $1 AND user_id = $2', [environment, userId])
  const stableId = rows[0]?.stable_id ?? null
  if (stableId) await redis.set(keys.alias(environment, userId), stableId, 'EX', 3600).catch(() => undefined)
  return stableId
}
