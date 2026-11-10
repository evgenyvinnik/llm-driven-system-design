/**
 * Small seeded random numbers. Everything the planner search and the simulator
 * draw comes from here, so a run is reproducible from its seed.
 * @module shared/rng
 */

/** Mulberry32: fast, 32-bit state, good enough for search perturbations and scenario noise. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a over a string: stable across runs and processes. */
export function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** One uniform draw that depends only on (seed, label), not on the order draws happen in. */
export function draw(seed: number, label: string): number {
  return makeRng(hash32(`${seed}|${label}`))()
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1))
}
