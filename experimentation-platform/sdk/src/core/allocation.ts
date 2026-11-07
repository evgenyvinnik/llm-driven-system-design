/**
 * Bucket-range allocation: which variant owns which buckets, and how ranges
 * change when weights change.
 *
 * The rule that keeps an experiment valid through a ramp: a variant whose
 * weight does not shrink never loses a bucket. Shrinking variants release
 * buckets from the top of their ranges; growing variants take the buckets just
 * released first (those units are changing anyway), then never-allocated
 * buckets, lowest first. So ramping treatment 10% → 20% moves exactly 10% of
 * units, all of them control → treatment, and no treatment unit goes back.
 *
 * `allocateContiguous` and `expectedRehashChange` model the two common naive
 * alternatives (re-partition from bucket 0 on every change; re-hash with a new
 * salt or the version in the hash input) so the editor and the tests can show
 * what they would have done.
 * @module core/allocation
 */
import { BUCKETS, type Allocation, type Range } from './types.js'

/** Sorts, drops empties and merges touching ranges. Returns new arrays. */
export function normalizeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e] as Range)
    .sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push(r)
  }
  return out
}

export function rangesSize(ranges: Range[]): number {
  return ranges.reduce((n, [s, e]) => n + (e - s), 0)
}

/** The variant owning `bucket`, or null when the bucket is not allocated. */
export function variantAt(allocation: Allocation, bucket: number): string | null {
  for (const variant in allocation) {
    for (const [s, e] of allocation[variant]) {
      if (bucket >= s && bucket < e) return variant
    }
  }
  return null
}

/** Variant → number of buckets owned (its weight in basis points). */
export function weightsOf(allocation: Allocation): Record<string, number> {
  const out: Record<string, number> = {}
  for (const variant in allocation) out[variant] = rangesSize(allocation[variant])
  return out
}

/** Buckets owned by no variant, as sorted ranges. */
export function freeRanges(allocation: Allocation): Range[] {
  const used = normalizeRanges(Object.values(allocation).flat())
  const free: Range[] = []
  let cursor = 0
  for (const [s, e] of used) {
    if (s > cursor) free.push([cursor, s])
    cursor = Math.max(cursor, e)
  }
  if (cursor < BUCKETS) free.push([cursor, BUCKETS])
  return free
}

/** Returns an error message, or null when the allocation is well formed. */
export function validateAllocation(allocation: Allocation): string | null {
  const all: [number, number, string][] = []
  for (const variant in allocation) {
    for (const [s, e] of allocation[variant]) {
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > BUCKETS || e <= s) {
        return `variant ${variant} has an invalid range [${s}, ${e})`
      }
      all.push([s, e, variant])
    }
  }
  all.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < all.length; i++) {
    if (all[i][0] < all[i - 1][1]) return `ranges of ${all[i - 1][2]} and ${all[i][2]} overlap`
  }
  return null
}

export function validateWeights(weights: Record<string, number>): string | null {
  let total = 0
  for (const [variant, w] of Object.entries(weights)) {
    if (!Number.isInteger(w) || w < 0) return `weight of ${variant} must be a whole number of buckets`
    total += w
  }
  if (total > BUCKETS) return `weights add up to ${total / 100}%, more than 100%`
  return null
}

/** Takes up to `need` buckets from the front of `pool` (mutating it). */
function take(pool: Range[], need: number): Range[] {
  const taken: Range[] = []
  while (need > 0 && pool.length > 0) {
    const f = pool[0]
    const len = f[1] - f[0]
    if (len <= need) {
      taken.push([f[0], f[1]])
      pool.shift()
      need -= len
    } else {
      taken.push([f[0], f[0] + need])
      f[0] += need
      need = 0
    }
  }
  return taken
}

/**
 * New allocation with the given weights (buckets per variant) that moves the
 * fewest units: only buckets leaving a shrinking variant change hands.
 * Variants missing from `weights` release everything. From an empty current
 * allocation this lays variants out contiguously in key order of `weights`.
 */
export function allocateStable(current: Allocation, weights: Record<string, number>): Allocation {
  const error = validateWeights(weights)
  if (error) throw new Error(error)
  const variants = Object.keys(weights)
  const next: Allocation = {}
  const released: Range[] = []
  for (const variant in current) {
    if (!(variant in weights)) released.push(...current[variant].map(([s, e]) => [s, e] as Range))
  }
  for (const variant of variants) next[variant] = normalizeRanges(current[variant] ?? [])

  // 1. Shrink: release buckets from the top of each shrinking variant.
  for (const variant of variants) {
    const ranges = next[variant]
    let excess = rangesSize(ranges) - weights[variant]
    while (excess > 0) {
      const last = ranges[ranges.length - 1]
      const len = last[1] - last[0]
      if (len <= excess) {
        released.push([last[0], last[1]])
        ranges.pop()
        excess -= len
      } else {
        released.push([last[1] - excess, last[1]])
        last[1] -= excess
        excess = 0
      }
    }
  }

  // 2. Grow: just-released buckets first, then never-allocated ones, lowest first.
  const releasedPool = normalizeRanges(released)
  const releasedSet = releasedPool.map(([s, e]) => [s, e] as Range)
  const neverPool = freeRanges({ ...next, __released__: releasedSet })
  for (const variant of variants) {
    let need = weights[variant] - rangesSize(next[variant])
    if (need <= 0) continue
    const fromReleased = take(releasedPool, need)
    need -= rangesSize(fromReleased)
    const fromNever = take(neverPool, need)
    next[variant] = normalizeRanges([...next[variant], ...fromReleased, ...fromNever])
  }
  return next
}

/** Naive re-partitioning: lay the weights out from bucket 0 in the given order on every change. */
export function allocateContiguous(weights: Record<string, number>, order: string[] = Object.keys(weights)): Allocation {
  const error = validateWeights(weights)
  if (error) throw new Error(error)
  const out: Allocation = {}
  let cursor = 0
  for (const variant of order) {
    const w = weights[variant] ?? 0
    out[variant] = w > 0 ? [[cursor, cursor + w]] : []
    cursor += w
  }
  return out
}

export interface Transition {
  from: string | null
  to: string | null
  buckets: number
}

/** Exact comparison of two allocations, bucket by bucket (null = not allocated). */
export interface MoveSummary {
  totalBuckets: number
  /** Buckets whose assignment changes at all, including enrolling and unenrolling. */
  changed: number
  /** Buckets moving from one variant to a different variant (crossovers). */
  switched: number
  newlyEnrolled: number
  unenrolled: number
  transitions: Transition[]
  /** Per variant: buckets it owned before, and how many of those leave it. */
  leaving: Record<string, { before: number; left: number }>
}

export function compareAllocations(before: Allocation, after: Allocation): MoveSummary {
  const counts = new Map<string, Transition>()
  const leaving: MoveSummary['leaving'] = {}
  for (const v of new Set([...Object.keys(before), ...Object.keys(after)])) leaving[v] = { before: 0, left: 0 }
  let changed = 0
  let switched = 0
  let newlyEnrolled = 0
  let unenrolled = 0
  for (let b = 0; b < BUCKETS; b++) {
    const from = variantAt(before, b)
    const to = variantAt(after, b)
    if (from !== null) leaving[from].before++
    if (from === to) continue
    changed++
    if (from !== null) leaving[from].left++
    if (from !== null && to !== null) switched++
    else if (from === null) newlyEnrolled++
    else unenrolled++
    const id = `${from}→${to}`
    const t = counts.get(id) ?? { from, to, buckets: 0 }
    t.buckets++
    counts.set(id, t)
  }
  const transitions = [...counts.values()].sort((a, b) => b.buckets - a.buckets)
  return { totalBuckets: BUCKETS, changed, switched, newlyEnrolled, unenrolled, transitions, leaving }
}

/**
 * Expected effect of re-hashing (new salt, or the config version mixed into the
 * hash) when weights change: each unit's old and new buckets are independent.
 * Returns fractions in [0, 1].
 */
export function expectedRehashChange(
  before: Record<string, number>,
  after: Record<string, number>,
): { changed: number; leaving: Record<string, number> } {
  const states = new Set([...Object.keys(before), ...Object.keys(after)])
  const p = (w: Record<string, number>, v: string) => (w[v] ?? 0) / BUCKETS
  const unallocated = (w: Record<string, number>) => 1 - Object.values(w).reduce((a, b) => a + b, 0) / BUCKETS
  let same = unallocated(before) * unallocated(after)
  const leaving: Record<string, number> = {}
  for (const v of states) {
    same += p(before, v) * p(after, v)
    leaving[v] = 1 - p(after, v)
  }
  return { changed: 1 - same, leaving }
}
