/**
 * Experiment analysis from per-(variant, version) unit aggregates.
 *
 * A unit belongs to the variant of its FIRST exposure. Units exposed to more
 * than one variant (crossovers: a ramp moved them, or a sign-in merged two
 * identities) count toward the sample ratio check — they were assigned like
 * everyone else — but are left out of conversion rates, because their outcome
 * can't be attributed to one experience.
 *
 * The expected split for the SRM check is computed per config version: each
 * version's exposed units × that version's share of each variant. A ramp from
 * 10% to 20% therefore doesn't look like a broken split.
 * @module domain/analysis
 */
import { weightsOf, type Allocation } from '../shared/evaluation.js'
import { chiSquareGof, compareProportions, wilsonInterval, type ProportionComparison } from './stats.js'

/** One row per (first variant, first version), as returned by the ClickHouse query. */
export interface UnitAggregate {
  variant: string
  version: number
  /** Units whose first exposure (or assignment) was this variant at this version. */
  units: number
  /** Of those, units later seen in another variant. */
  crossovers: number
  /** Of the non-crossover units, how many converted after first exposure and within the window. */
  conversions: number
}

export interface ArmResult {
  variant: string
  units: number
  crossovers: number
  analyzedUnits: number
  conversions: number
  rate: number
  ci: [number, number]
  observedShare: number
  expectedShare: number
  expectedUnits: number
  /** Versus the control arm; null for control itself. */
  lift: (ProportionComparison & { significant: boolean }) | null
}

export interface SrmResult {
  chi2: number
  df: number
  pValue: number
  /** p below the threshold: the observed split is very unlikely under the configured weights. */
  flagged: boolean
  threshold: number
}

export interface AnalysisResult {
  totalUnits: number
  crossovers: number
  arms: ArmResult[]
  /** Null when there is too little data (an expected cell under 5). */
  srm: SrmResult | null
}

export interface AnalysisInput {
  /** Variant keys in display order; the first is control. */
  variants: string[]
  control: string
  rows: UnitAggregate[]
  /** Allocation of every config version that appears in `rows` (falls back to `current`). */
  allocations: Map<number, Allocation>
  current: Allocation
  alpha?: number
  srmThreshold?: number
}

/** Each variant's share of the enrolled buckets in an allocation. */
export function enrolledShares(allocation: Allocation, variants: string[]): Record<string, number> {
  const w = weightsOf(allocation)
  const total = variants.reduce((s, v) => s + (w[v] ?? 0), 0)
  const out: Record<string, number> = {}
  for (const v of variants) out[v] = total > 0 ? (w[v] ?? 0) / total : 0
  return out
}

export function analyze(input: AnalysisInput): AnalysisResult {
  const alpha = input.alpha ?? 0.05
  const srmThreshold = input.srmThreshold ?? 0.001
  const byVariant = new Map<string, { units: number; crossovers: number; conversions: number }>()
  for (const v of input.variants) byVariant.set(v, { units: 0, crossovers: 0, conversions: 0 })
  const unitsByVersion = new Map<number, number>()
  for (const row of input.rows) {
    const agg = byVariant.get(row.variant)
    if (!agg) continue // a variant no longer defined; ignored
    agg.units += row.units
    agg.crossovers += row.crossovers
    agg.conversions += row.conversions
    unitsByVersion.set(row.version, (unitsByVersion.get(row.version) ?? 0) + row.units)
  }

  const expected = new Map<string, number>(input.variants.map((v) => [v, 0]))
  for (const [version, n] of unitsByVersion) {
    const shares = enrolledShares(input.allocations.get(version) ?? input.current, input.variants)
    for (const v of input.variants) expected.set(v, (expected.get(v) ?? 0) + n * shares[v])
  }

  const totalUnits = [...byVariant.values()].reduce((s, a) => s + a.units, 0)
  const crossovers = [...byVariant.values()].reduce((s, a) => s + a.crossovers, 0)
  const control = byVariant.get(input.control) ?? { units: 0, crossovers: 0, conversions: 0 }
  const controlAnalyzed = control.units - control.crossovers

  const arms: ArmResult[] = input.variants.map((variant) => {
    const a = byVariant.get(variant)!
    const analyzedUnits = a.units - a.crossovers
    const exp = expected.get(variant) ?? 0
    let lift: ArmResult['lift'] = null
    if (variant !== input.control) {
      const cmp = compareProportions(control.conversions, controlAnalyzed, a.conversions, analyzedUnits)
      lift = { ...cmp, significant: controlAnalyzed > 0 && analyzedUnits > 0 && cmp.pValue < alpha }
    }
    return {
      variant,
      units: a.units,
      crossovers: a.crossovers,
      analyzedUnits,
      conversions: a.conversions,
      rate: analyzedUnits > 0 ? a.conversions / analyzedUnits : 0,
      ci: wilsonInterval(a.conversions, analyzedUnits),
      observedShare: totalUnits > 0 ? a.units / totalUnits : 0,
      expectedShare: totalUnits > 0 ? exp / totalUnits : 0,
      expectedUnits: exp,
      lift,
    }
  })

  const expectedCounts = arms.map((a) => a.expectedUnits)
  const enoughData = expectedCounts.filter((e) => e > 0).length >= 2 && expectedCounts.every((e) => e === 0 || e >= 5)
  let srm: SrmResult | null = null
  if (enoughData) {
    const gof = chiSquareGof(
      arms.map((a) => a.units),
      expectedCounts,
    )
    srm = { ...gof, flagged: gof.pValue < srmThreshold, threshold: srmThreshold }
  }
  return { totalUnits, crossovers, arms, srm }
}
