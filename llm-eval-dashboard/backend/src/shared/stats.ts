/**
 * Statistics for eval runs and comparisons. Pure functions, no I/O.
 *
 * The unit of analysis is the CASE, not the sample: samples of one case are
 * correlated (same input, same reference), so treating 5 samples × 20 cases as
 * 100 independent observations would make every interval far too narrow.
 * Per-case means are computed first, and every interval is over those.
 *
 * - tInterval: Student-t interval on per-case means (closed form, deterministic).
 * - bootstrapInterval: percentile bootstrap over cases with a seeded RNG, so the
 *   same rows always produce the same interval (and tests can pin it).
 * - pairedComparison: per-case differences on the same dataset version.
 * - welchInterval: unpaired difference, used only when pairing is impossible.
 * @module shared/stats
 */

export interface Interval {
  n: number
  mean: number
  sd: number
  se: number
  lo: number
  hi: number
  df: number
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** Sample variance (n − 1 denominator); 0 for fewer than two values. */
export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  let ss = 0
  for (const v of values) ss += (v - m) * (v - m)
  return ss / (values.length - 1)
}

export function stdev(values: readonly number[]): number {
  return Math.sqrt(variance(values))
}

// ── Student t distribution ───────────────────────────────────────────────────

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9); accurate to ~1e-15 for x > 0.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Continued fraction for the incomplete beta function (Numerical Recipes betacf). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIter = 300
  const eps = 3e-14
  const fpmin = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < fpmin) d = fpmin
  d = 1 / d
  let h = d
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < fpmin) d = fpmin
    c = 1 + aa / c
    if (Math.abs(c) < fpmin) c = fpmin
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < fpmin) d = fpmin
    c = 1 + aa / c
    if (Math.abs(c) < fpmin) c = fpmin
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < eps) break
  }
  return h
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  const front = Math.exp(lnFront)
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b
}

/** CDF of Student's t with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t)
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5)
  return t >= 0 ? 1 - tail : tail
}

/** Inverse CDF of Student's t (bisection on tCdf; df may be fractional, as in Welch). */
export function tQuantile(p: number, df: number): number {
  if (!(df > 0)) return NaN
  if (p === 0.5) return 0
  let lo = -1000
  let hi = 1000
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (tCdf(mid, df) < p) lo = mid
    else hi = mid
    if (hi - lo < 1e-10) break
  }
  return (lo + hi) / 2
}

// ── Intervals ────────────────────────────────────────────────────────────────

/** Two-sided t-interval for the mean. With one value the interval is undefined (NaN bounds). */
export function tInterval(values: readonly number[], confidence = 0.95): Interval {
  const n = values.length
  const m = mean(values)
  const sd = stdev(values)
  const se = n > 0 ? sd / Math.sqrt(n) : NaN
  if (n < 2) return { n, mean: m, sd, se, lo: NaN, hi: NaN, df: Math.max(0, n - 1) }
  const q = tQuantile(1 - (1 - confidence) / 2, n - 1)
  return { n, mean: m, sd, se, lo: m - q * se, hi: m + q * se, df: n - 1 }
}

/** Seeded PRNG (mulberry32): the bootstrap must give the same interval for the same rows. */
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

function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** Percentile bootstrap of the mean, resampling cases with replacement. */
export function bootstrapInterval(values: readonly number[], opts: { resamples?: number; seed?: number; confidence?: number } = {}): { lo: number; hi: number; resamples: number } {
  const resamples = opts.resamples ?? 2000
  const confidence = opts.confidence ?? 0.95
  const n = values.length
  if (n < 2) return { lo: NaN, hi: NaN, resamples }
  const rand = mulberry32(opts.seed ?? 12345)
  const means = new Array<number>(resamples)
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)]
    means[r] = sum / n
  }
  means.sort((x, y) => x - y)
  const alpha = (1 - confidence) / 2
  return { lo: quantileSorted(means, alpha), hi: quantileSorted(means, 1 - alpha), resamples }
}

// ── Comparisons ──────────────────────────────────────────────────────────────

export type Verdict = 'improvement' | 'regression' | 'not_significant' | 'insufficient_data'

export interface PairedResult {
  n: number
  meanA: number
  meanB: number
  meanDiff: number
  sdDiff: number
  ci: [number, number]
  bootstrapCi: [number, number]
  wins: number
  losses: number
  ties: number
  verdict: Verdict
}

/** Verdict from an interval on B − A: significant only when the interval excludes zero. */
export function verdictFromInterval(lo: number, hi: number, n: number): Verdict {
  if (n < 2 || !Number.isFinite(lo) || !Number.isFinite(hi)) return 'insufficient_data'
  if (lo > 0) return 'improvement'
  if (hi < 0) return 'regression'
  return 'not_significant'
}

/**
 * Paired comparison of B against A over cases scored in both runs.
 * A case is a win for B when its per-case mean is higher by more than `tieEpsilon`.
 */
export function pairedComparison(pairs: readonly { a: number; b: number }[], opts: { tieEpsilon?: number; seed?: number } = {}): PairedResult {
  const eps = opts.tieEpsilon ?? 1e-9
  const diffs = pairs.map((p) => p.b - p.a)
  const interval = tInterval(diffs)
  const boot = bootstrapInterval(diffs, { seed: opts.seed })
  let wins = 0
  let losses = 0
  let ties = 0
  for (const d of diffs) {
    if (d > eps) wins++
    else if (d < -eps) losses++
    else ties++
  }
  return {
    n: pairs.length,
    meanA: mean(pairs.map((p) => p.a)),
    meanB: mean(pairs.map((p) => p.b)),
    meanDiff: interval.mean,
    sdDiff: interval.sd,
    ci: [interval.lo, interval.hi],
    bootstrapCi: [boot.lo, boot.hi],
    wins,
    losses,
    ties,
    verdict: verdictFromInterval(interval.lo, interval.hi, pairs.length),
  }
}

export interface WelchResult {
  nA: number
  nB: number
  meanA: number
  meanB: number
  meanDiff: number
  df: number
  ci: [number, number]
  verdict: Verdict
}

/** Unpaired (Welch) interval for mean(B) − mean(A) with Welch–Satterthwaite degrees of freedom. */
export function welchInterval(a: readonly number[], b: readonly number[], confidence = 0.95): WelchResult {
  const nA = a.length
  const nB = b.length
  const meanA = mean(a)
  const meanB = mean(b)
  const vA = variance(a) / nA
  const vB = variance(b) / nB
  const se = Math.sqrt(vA + vB)
  const df = (vA + vB) ** 2 / ((vA * vA) / (nA - 1) + (vB * vB) / (nB - 1))
  const diff = meanB - meanA
  if (nA < 2 || nB < 2 || !(se > 0)) {
    const degenerate = nA >= 2 && nB >= 2 && se === 0
    return { nA, nB, meanA, meanB, meanDiff: diff, df: NaN, ci: degenerate ? [diff, diff] : [NaN, NaN], verdict: degenerate ? verdictFromInterval(diff, diff, Math.min(nA, nB)) : 'insufficient_data' }
  }
  const q = tQuantile(1 - (1 - confidence) / 2, df)
  const lo = diff - q * se
  const hi = diff + q * se
  return { nA, nB, meanA, meanB, meanDiff: diff, df, ci: [lo, hi], verdict: verdictFromInterval(lo, hi, Math.min(nA, nB)) }
}
