/**
 * Deterministic bucketing. MurmurHash3 (x86, 32-bit) over the UTF-8 bytes of
 * `${salt}.${unitId}`, reduced to [0, BUCKETS). Pure, synchronous and
 * dependency-free, so the browser SDK, the Node SDK and the server produce
 * the same bucket for the same unit without a network call or async crypto.
 * @module core/hash
 */
import { BUCKETS } from './types.js'

const encoder = new TextEncoder()

const C1 = 0xcc9e2d51
const C2 = 0x1b873593

function mixK(k: number): number {
  k = Math.imul(k, C1)
  k = (k << 15) | (k >>> 17)
  return Math.imul(k, C2)
}

/** MurmurHash3_x86_32. Returns an unsigned 32-bit integer. */
export function murmur3(input: string, seed = 0): number {
  const data = encoder.encode(input)
  const len = data.length
  const blocks = len >>> 2
  let h = seed >>> 0
  for (let i = 0; i < blocks; i++) {
    const o = i * 4
    const k = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)
    h ^= mixK(k)
    h = (h << 13) | (h >>> 19)
    h = (Math.imul(h, 5) + 0xe6546b64) | 0
  }
  const tail = blocks * 4
  const rest = len & 3
  let k = 0
  if (rest === 3) k ^= data[tail + 2] << 16
  if (rest >= 2) k ^= data[tail + 1] << 8
  if (rest >= 1) {
    k ^= data[tail]
    h ^= mixK(k)
  }
  h ^= len
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * The bucket a unit falls into for a given salt. The salt is per flag, so the
 * same user lands in independent buckets across experiments. The modulo bias
 * (2^32 mod 10000 = 7296) shifts each bucket's probability by under 0.0003%.
 */
export function bucketOf(salt: string, unitId: string): number {
  return murmur3(`${salt}.${unitId}`) % BUCKETS
}
