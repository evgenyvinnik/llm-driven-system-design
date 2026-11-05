/**
 * Thresholds live in one PostgreSQL row with a version, edited on the admin
 * page. The analyzer caches them for a few seconds; a change takes effect on
 * the next pass it scores.
 * @module shared/thresholds
 */
import { DEFAULT_THRESHOLDS, type Thresholds } from './domain.js'
import { pool, type Queryable } from './db.js'

let cached: { value: { config: Thresholds; version: number }; at: number } | null = null
const TTL_MS = 3000

/** Fills any missing key with its default, so adding a threshold never breaks an old row. */
export function normalizeThresholds(raw: Partial<Thresholds> | null | undefined): Thresholds {
  const out = { ...DEFAULT_THRESHOLDS }
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>) {
    const value = raw?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

export async function loadThresholds(db: Queryable = pool, fresh = false): Promise<{ config: Thresholds; version: number }> {
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value
  const { rows } = await db.query<{ config: Partial<Thresholds>; version: number }>('SELECT config, version FROM thresholds WHERE id = 1')
  const value = { config: normalizeThresholds(rows[0]?.config), version: rows[0]?.version ?? 0 }
  cached = { value, at: Date.now() }
  return value
}

export function invalidateThresholds(): void {
  cached = null
}
