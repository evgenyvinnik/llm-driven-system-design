/**
 * In-memory catalog of setting definitions, per API instance.
 *
 * Every PATCH validates against the catalog, so it is cached. Three things keep
 * the cache honest across instances:
 * 1. a `catalog` pub/sub event invalidates it on every instance;
 * 2. a TTL bounds staleness if that event is lost;
 * 3. an unknown key forces one reload before the request is rejected, so a
 *    definition created a moment ago on another instance is never refused.
 * @module services/catalog
 */
import { config } from '../shared/config.js'
import { pool, type Queryable } from '../shared/db.js'
import { catalogReloads } from '../shared/metrics.js'
import type { Definition } from '../domain/types.js'
import { loadDefinitions } from './rows.js'

export interface Catalog {
  revision: number
  defs: Map<string, Definition>
  list: Definition[]
}

let cached: { catalog: Catalog; loadedAt: number; seq: number } | null = null
let inflight: Promise<Catalog> | null = null
let loadSeq = 0

async function load(reason: string, q: Queryable): Promise<Catalog> {
  catalogReloads.inc({ reason })
  const seq = ++loadSeq
  const { revision, defs } = await loadDefinitions(q)
  const catalog: Catalog = { revision, defs: new Map(defs.map((d) => [d.key, d])), list: defs }
  // The read that started last wins, so a slow older read can't overwrite a newer one. Comparing
  // start order rather than revisions lets the catalog go backwards after a restore or reseed.
  if (!cached || cached.seq < seq) cached = { catalog, loadedAt: Date.now(), seq }
  return cached.catalog
}

export async function getCatalog(q: Queryable = pool): Promise<Catalog> {
  if (cached && Date.now() - cached.loadedAt < config.catalogTtlMs) return cached.catalog
  const reason = cached ? 'ttl' : 'cold'
  inflight ??= load(reason, q).finally(() => {
    inflight = null
  })
  return inflight
}

/** Returns a catalog that contains every key, reloading once if any is missing. */
export async function getCatalogFor(keysNeeded: string[]): Promise<Catalog> {
  const catalog = await getCatalog()
  if (keysNeeded.every((k) => catalog.defs.has(k))) return catalog
  return load('unknown_key', pool)
}

/** Called when a `catalog` event arrives (from any instance, including this one). */
export function invalidateCatalog(revision?: number): void {
  if (!cached) return
  if (revision === undefined || cached.catalog.revision < revision) cached = null
}

/** Test hook. */
export function resetCatalogCache(): void {
  cached = null
  inflight = null
}
