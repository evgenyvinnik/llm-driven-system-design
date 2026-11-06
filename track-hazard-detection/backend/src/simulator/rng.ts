/** Deterministic pseudo-random numbers so a scenario run is repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function between(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo)
}

export const round1 = (n: number) => Math.round(n * 10) / 10
