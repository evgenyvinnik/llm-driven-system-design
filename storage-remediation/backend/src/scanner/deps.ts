/**
 * Dependencies shared by scanner passes, so the same code runs in the scanner
 * process (HTTP control plane) and in the seed script (in-process control plane).
 * @module scanner/deps
 */
import type { ArmResult, ControlPlane } from '../arm/control-plane.js'
import type { Queryable } from '../shared/db.js'

export interface ScanDeps {
  db: Queryable
  arm: ControlPlane
  shard: { index: number; count: number }
  lookbackDays: number
  minEvidenceDays: number
  readConcurrency: number
  childRefreshMs: number
  evidenceTtlMs: number
  sleep: (ms: number) => Promise<void>
  log: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void }
}

/** FNV-1a: stable subscription → shard assignment across processes. */
export function shardOf(subscriptionId: string, count: number): number {
  let h = 2166136261
  for (let i = 0; i < subscriptionId.length; i++) h = Math.imul(h ^ subscriptionId.charCodeAt(i), 16777619)
  return (h >>> 0) % Math.max(1, count)
}

export function ownsSubscription(subscriptionId: string, shard: ScanDeps['shard']): boolean {
  return shardOf(subscriptionId, shard.count) === shard.index
}

/** Retries a control-plane call on 429/503, sleeping for the server's Retry-After. */
export async function withBackoff<T>(deps: Pick<ScanDeps, 'sleep'>, call: () => Promise<ArmResult<T>>, maxAttempts = 6): Promise<ArmResult<T>> {
  let result = await call()
  for (let attempt = 1; attempt < maxAttempts && (result.status === 429 || result.status === 503); attempt++) {
    await deps.sleep(result.retryAfterMs ?? 1000)
    result = await call()
  }
  return result
}

/** Runs `fn` over items with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}
