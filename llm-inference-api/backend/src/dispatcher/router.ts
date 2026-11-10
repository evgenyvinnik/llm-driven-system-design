/**
 * Routing: consistent hashing with bounded load on a prefix key.
 *
 * Why affinity at all: requests that share a prefix (the same system prompt)
 * are cheaper on the backend that already holds that prefix in its KV cache.
 * That is a performance preference, never a correctness requirement, so the
 * router gives it up whenever it conflicts with load, draining or health.
 *
 * - Each backend owns `vnodes` points on a 32-bit ring; a key's preference
 *   order is the distinct backends met walking clockwise from its hash.
 * - Bounded load (Mirrokni et al.): a backend is skipped when taking one more
 *   request would put it above ceil(average × (1 + ε)). Below `lowLoadFraction`
 *   of its slots the bound is relaxed, so at low traffic affinity always wins.
 * - Adding or removing a backend moves only the keys whose owner changed
 *   (about 1/N of them); `membershipChange` measures it against modulo hashing.
 * @module dispatcher/router
 */
import { createHash } from 'node:crypto'

export interface BackendLoad {
  id: string
  /** Healthy, not draining, not restarting, not in cooldown. */
  routable: boolean
  inUse: number
  slots: number
}

export interface RouteOptions {
  epsilon: number
  lowLoadFraction: number
}

export interface RouteDecision {
  backendId: string
  affinity: 'primary' | 'spill'
  /** Why the primary owner was skipped, when it was. */
  spillReason?: 'not_routable' | 'full' | 'load_bound'
}

/**
 * Position on the 32-bit ring: the first 4 bytes of SHA-256. FNV-1a on short,
 * similar labels ("b1#0", "b1#1", ...) left the three backends at 25/36/39%
 * of the key space; SHA-256 with 160 virtual nodes lands within a few points
 * of a third each. Hashing one prefix key per request costs microseconds.
 */
export function keyHash(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0)
}

export class HashRing {
  private points: { hash: number; id: string }[] = []
  readonly ids: string[]

  constructor(ids: string[], vnodes = 160) {
    this.ids = [...ids]
    for (const id of ids) {
      for (let v = 0; v < vnodes; v++) this.points.push({ hash: keyHash(`${id}#${v}`), id })
    }
    this.points.sort((a, b) => a.hash - b.hash || a.id.localeCompare(b.id))
  }

  /** Distinct backends in ring order starting at the key's position. */
  preference(key: string): string[] {
    if (this.points.length === 0) return []
    const h = keyHash(key)
    let lo = 0
    let hi = this.points.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.points[mid].hash < h) lo = mid + 1
      else hi = mid
    }
    const order: string[] = []
    for (let i = 0; i < this.points.length && order.length < this.ids.length; i++) {
      const id = this.points[(lo + i) % this.points.length].id
      if (!order.includes(id)) order.push(id)
    }
    return order
  }

  owner(key: string): string | undefined {
    return this.preference(key)[0]
  }
}

/**
 * Picks a backend for one request. `loads` must already include requests
 * assigned earlier in the same batch, so a batch spreads instead of piling up.
 * Returns null when no routable backend has a free slot.
 */
export function route(ring: HashRing, key: string, loads: Map<string, BackendLoad>, opts: RouteOptions): RouteDecision | null {
  const routable = [...loads.values()].filter((b) => b.routable)
  if (routable.length === 0) return null
  const total = routable.reduce((n, b) => n + b.inUse, 0) + 1
  const avg = total / routable.length
  const order = ring.preference(key)
  const primary = order[0]
  let spillReason: RouteDecision['spillReason']
  for (const id of order) {
    const b = loads.get(id)
    if (!b || !b.routable) {
      if (id === primary) spillReason = 'not_routable'
      continue
    }
    if (b.inUse >= b.slots) {
      if (id === primary) spillReason = 'full'
      continue
    }
    const bound = Math.max(Math.ceil(avg * (1 + opts.epsilon)), Math.floor(b.slots * opts.lowLoadFraction))
    if (b.inUse + 1 > bound) {
      if (id === primary) spillReason = 'load_bound'
      continue
    }
    return id === primary ? { backendId: id, affinity: 'primary' } : { backendId: id, affinity: 'spill', spillReason }
  }
  return null
}

export interface MembershipChange {
  keys: number
  movedConsistent: number
  movedModulo: number
  /** Share of keys each backend owns after the change. */
  shares: Record<string, number>
}

/**
 * What a membership change does to existing assignments: the fraction of keys
 * whose owner changes with consistent hashing vs `hash mod N`.
 */
export function membershipChange(before: string[], after: string[], keys: string[], vnodes = 160): MembershipChange {
  const r1 = new HashRing(before, vnodes)
  const r2 = new HashRing(after, vnodes)
  let movedConsistent = 0
  let movedModulo = 0
  const counts: Record<string, number> = Object.fromEntries(after.map((id) => [id, 0]))
  for (const k of keys) {
    const o2 = r2.owner(k) as string
    if (r1.owner(k) !== o2) movedConsistent++
    counts[o2]++
    const h = keyHash(k)
    if (before[h % before.length] !== after[h % after.length]) movedModulo++
  }
  const shares = Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, n / keys.length]))
  return { keys: keys.length, movedConsistent: movedConsistent / keys.length, movedModulo: movedModulo / keys.length, shares }
}
