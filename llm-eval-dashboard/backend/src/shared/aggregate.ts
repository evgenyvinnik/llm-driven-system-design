/**
 * Run aggregates from raw rows. Pure: the API, the seed and the tests all call
 * this with rows read from case_results and scores.
 *
 * Rules (the "never average silently" contract):
 * - Only samples whose generation SUCCEEDED and that have a score for the
 *   scorer version count. Everything else is counted, never dropped quietly:
 *   errored samples, cancelled samples, unscored samples (pending/failed score).
 * - A case's value is the mean over its scored samples. A case with no scored
 *   sample is excluded from the mean and reported (erroredCases / unscoredCases).
 * - The run mean is the mean of case values; the interval is over cases.
 * - Per-case variance across samples is what makes a case "flaky".
 * @module shared/aggregate
 */
import { bootstrapInterval, mean, tInterval, variance } from './stats.js'

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'errored' | 'cancelled'

export interface SampleRow {
  caseKey: string
  sampleIndex: number
  status: TaskStatus
  /** Score for the scorer version being aggregated; null when not (yet) scored. */
  score: number | null
  passed?: boolean | null
}

export interface CaseAggregate {
  caseKey: string
  samples: number
  scored: number
  errored: number
  cancelled: number
  pending: number
  mean: number | null
  variance: number
  /** Samples disagree on pass/fail (or on score): the case is nondeterministic under this config. */
  flaky: boolean
  passRate: number | null
}

export interface RunAggregate {
  /** Cases in the run's dataset version. */
  totalCases: number
  /** Cases with at least one scored sample: the n of the interval. */
  scoredCases: number
  mean: number | null
  ci: [number, number] | null
  bootstrapCi: [number, number] | null
  ciHalfWidth: number | null
  /** Task-level (case × sample) counts. */
  totalTasks: number
  succeededTasks: number
  erroredTasks: number
  cancelledTasks: number
  pendingTasks: number
  unscoredTasks: number
  /** Cases where every sample errored: excluded from the mean, shown next to it. */
  erroredCases: number
  /** Cases with some scored and some errored samples: included, flagged. */
  partialCases: number
  /** Cases with succeeded samples but no score yet (scoring pending or failed). */
  unscoredCases: number
  flakyCases: number
  /** Mean within-case variance across samples (sampling noise). */
  meanWithinVariance: number | null
  /** Variance of case means (case-to-case spread). */
  betweenVariance: number | null
}

export function aggregateCases(rows: readonly SampleRow[]): CaseAggregate[] {
  const byCase = new Map<string, SampleRow[]>()
  for (const row of rows) {
    const list = byCase.get(row.caseKey)
    if (list) list.push(row)
    else byCase.set(row.caseKey, [row])
  }
  const out: CaseAggregate[] = []
  for (const [caseKey, list] of byCase) {
    const scoredRows = list.filter((r) => r.status === 'succeeded' && r.score !== null)
    const scores = scoredRows.map((r) => r.score as number)
    const passes = scoredRows.filter((r) => r.passed !== undefined && r.passed !== null).map((r) => (r.passed ? 1 : 0))
    const v = variance(scores)
    const passDisagree = passes.length > 1 && passes.some((p) => p !== passes[0])
    out.push({
      caseKey,
      samples: list.length,
      scored: scores.length,
      errored: list.filter((r) => r.status === 'errored').length,
      cancelled: list.filter((r) => r.status === 'cancelled').length,
      pending: list.filter((r) => r.status === 'pending' || r.status === 'running').length,
      mean: scores.length > 0 ? mean(scores) : null,
      variance: v,
      flaky: passDisagree || v > 1e-9,
      passRate: passes.length > 0 ? mean(passes) : null,
    })
  }
  return out
}

export function aggregateRun(rows: readonly SampleRow[], opts: { bootstrapSeed?: number } = {}): RunAggregate {
  const cases = aggregateCases(rows)
  const caseMeans = cases.filter((c) => c.mean !== null).map((c) => c.mean as number)
  const interval = tInterval(caseMeans)
  const boot = bootstrapInterval(caseMeans, { seed: opts.bootstrapSeed })
  const succeeded = rows.filter((r) => r.status === 'succeeded')
  const hasCi = caseMeans.length >= 2 && Number.isFinite(interval.lo)
  const withScores = cases.filter((c) => c.scored > 0)
  return {
    totalCases: cases.length,
    scoredCases: caseMeans.length,
    mean: caseMeans.length > 0 ? interval.mean : null,
    ci: hasCi ? [interval.lo, interval.hi] : null,
    bootstrapCi: hasCi ? [boot.lo, boot.hi] : null,
    ciHalfWidth: hasCi ? (interval.hi - interval.lo) / 2 : null,
    totalTasks: rows.length,
    succeededTasks: succeeded.length,
    erroredTasks: rows.filter((r) => r.status === 'errored').length,
    cancelledTasks: rows.filter((r) => r.status === 'cancelled').length,
    pendingTasks: rows.filter((r) => r.status === 'pending' || r.status === 'running').length,
    unscoredTasks: succeeded.filter((r) => r.score === null).length,
    erroredCases: cases.filter((c) => c.scored === 0 && c.errored > 0 && c.errored + c.cancelled === c.samples).length,
    partialCases: cases.filter((c) => c.scored > 0 && c.errored > 0).length,
    unscoredCases: cases.filter((c) => c.scored === 0 && c.samples - c.errored - c.cancelled - c.pending > 0).length,
    flakyCases: cases.filter((c) => c.flaky).length,
    meanWithinVariance: withScores.length > 0 ? mean(withScores.map((c) => c.variance)) : null,
    betweenVariance: caseMeans.length > 1 ? variance(caseMeans) : null,
  }
}

/** Per-case means keyed by case, for pairing two runs. Cases with no scored sample are absent. */
export function caseMeans(rows: readonly SampleRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of aggregateCases(rows)) if (c.mean !== null) out.set(c.caseKey, c.mean)
  return out
}
