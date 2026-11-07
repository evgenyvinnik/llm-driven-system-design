/**
 * Statistics for the results page: Wilson score intervals for each arm's
 * conversion rate, a two-proportion z-test with intervals for the absolute
 * and relative difference, and a chi-square goodness-of-fit test for sample
 * ratio mismatch. Dependency-free and unit-tested against known values.
 * @module domain/stats
 */

export const Z95 = 1.959963984540054

/** Complementary error function (Numerical Recipes erfcc; fractional error < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    )
  return x >= 0 ? r : 2 - r
}

export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2)
}

/** Two-sided p-value of a standard normal statistic. */
export function twoSidedP(z: number): number {
  return Math.min(1, erfc(Math.abs(z) / Math.SQRT2))
}

/** Wilson score interval: well behaved at small n and at rates near 0 or 1, unlike p ± z·SE. */
export function wilsonInterval(successes: number, n: number, z = Z95): [number, number] {
  if (n === 0) return [0, 0]
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

export interface ProportionComparison {
  controlRate: number
  treatmentRate: number
  absDiff: number
  absLow: number
  absHigh: number
  /** (treatment − control) / control */
  relLift: number | null
  relLow: number | null
  relHigh: number | null
  z: number
  pValue: number
}

/**
 * Two-proportion z-test (pooled standard error for the test, unpooled for the
 * interval). The relative-lift interval uses the delta method on the ratio.
 */
export function compareProportions(xc: number, nc: number, xt: number, nt: number, z = Z95): ProportionComparison {
  const pc = nc > 0 ? xc / nc : 0
  const pt = nt > 0 ? xt / nt : 0
  const diff = pt - pc
  const pooled = nc + nt > 0 ? (xc + xt) / (nc + nt) : 0
  const se0 = nc > 0 && nt > 0 ? Math.sqrt(pooled * (1 - pooled) * (1 / nc + 1 / nt)) : 0
  const stat = se0 > 0 ? diff / se0 : 0
  const varC = nc > 0 ? (pc * (1 - pc)) / nc : 0
  const varT = nt > 0 ? (pt * (1 - pt)) / nt : 0
  const se = Math.sqrt(varC + varT)
  let relLift: number | null = null
  let relLow: number | null = null
  let relHigh: number | null = null
  if (pc > 0) {
    relLift = diff / pc
    const seRel = Math.sqrt(varT / (pc * pc) + (pt * pt * varC) / (pc * pc * pc * pc))
    relLow = relLift - z * seRel
    relHigh = relLift + z * seRel
  }
  return {
    controlRate: pc,
    treatmentRate: pt,
    absDiff: diff,
    absLow: diff - z * se,
    absHigh: diff + z * se,
    relLift,
    relLow,
    relHigh,
    z: stat,
    pValue: se0 > 0 ? twoSidedP(stat) : 1,
  }
}

/** ln Γ(x), Lanczos approximation. */
function lnGamma(x: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Regularized upper incomplete gamma Q(a, x) (series for x < a+1, continued fraction otherwise). */
export function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1
  const gln = lnGamma(a)
  if (x < a + 1) {
    let ap = a
    let sum = 1 / a
    let del = sum
    for (let n = 0; n < 500; n++) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln)
  }
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h
}

/** Upper tail of the chi-square distribution: P(X ≥ x) with `df` degrees of freedom. */
export function chiSquareSf(x: number, df: number): number {
  return gammaQ(df / 2, x / 2)
}

export interface GoodnessOfFit {
  chi2: number
  df: number
  pValue: number
}

/** Pearson chi-square goodness of fit of observed counts against expected counts. */
export function chiSquareGof(observed: number[], expected: number[]): GoodnessOfFit {
  let chi2 = 0
  let cells = 0
  for (let i = 0; i < observed.length; i++) {
    if (expected[i] <= 0) continue
    chi2 += (observed[i] - expected[i]) ** 2 / expected[i]
    cells++
  }
  const df = Math.max(1, cells - 1)
  return { chi2, df, pValue: chiSquareSf(chi2, df) }
}
