/**
 * Seeded randomness. The ETA model and the simulator must be reproducible: a replay recomputes exactly the
 * same ETA from the same events, so every random draw comes from a generator seeded by the inputs.
 * @module domain/rng
 */

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

export function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** Standard normal draw (Box-Muller). */
export function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const Z90 = 1.2815515655446004

/** Log-normal draw fitted to a median and a 90th percentile (minutes). */
export function logNormal(rng: () => number, p50: number, p90: number): number {
  const mu = Math.log(Math.max(p50, 1))
  const sigma = Math.max((Math.log(Math.max(p90, p50 + 1)) - mu) / Z90, 0.01)
  return Math.exp(mu + sigma * normal(rng))
}

/**
 * A draw conditioned on already having waited `elapsed` minutes (the car has been in the yard that long):
 * rejection sampling, falling back to a short remaining wait in the far tail.
 */
export function logNormalGiven(rng: () => number, p50: number, p90: number, elapsed: number): number {
  if (elapsed <= 0) return logNormal(rng, p50, p90)
  for (let i = 0; i < 40; i++) {
    const s = logNormal(rng, p50, p90)
    if (s > elapsed) return s
  }
  return elapsed + 30 + rng() * 90
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[idx]
}
