/**
 * The rollback decision during a target's bake period. Compares authorization
 * failures since the change against the account's own baseline from just
 * before it. All three conditions must hold, so one stray 403 on a busy
 * account, or a steady background of failures that predates the change, does
 * not trigger a rollback.
 * @module domain/bake
 */

export interface MetricWindow {
  requests: number
  authErrors: number
  /** Window length in minutes (fractional is fine). */
  minutes: number
}

export interface BakeThresholds {
  minErrors: number
  baselineMultiplier: number
  minErrorRate: number
}

export interface BakeDecision {
  rollback: boolean
  reason: string
  errorRate: number
  errorsPerMin: number
  baselinePerMin: number
}

export function evaluateBakeSignal(baseline: MetricWindow, current: MetricWindow, t: BakeThresholds): BakeDecision {
  const baselinePerMin = baseline.minutes > 0 ? baseline.authErrors / baseline.minutes : 0
  const errorsPerMin = current.minutes > 0 ? current.authErrors / current.minutes : 0
  const errorRate = current.requests > 0 ? current.authErrors / current.requests : 0
  const base = { errorRate, errorsPerMin, baselinePerMin }
  if (current.authErrors < t.minErrors) {
    return { rollback: false, reason: `${current.authErrors} auth failures (< ${t.minErrors})`, ...base }
  }
  if (errorsPerMin <= Math.max(baselinePerMin * t.baselineMultiplier, 0.5)) {
    return { rollback: false, reason: `failures within ${t.baselineMultiplier}× baseline`, ...base }
  }
  if (errorRate < t.minErrorRate) {
    return { rollback: false, reason: `error rate ${(errorRate * 100).toFixed(1)}% below ${(t.minErrorRate * 100).toFixed(1)}%`, ...base }
  }
  return {
    rollback: true,
    reason: `${current.authErrors} authorization failures since change (${errorsPerMin.toFixed(1)}/min vs baseline ${baselinePerMin.toFixed(1)}/min, ${(errorRate * 100).toFixed(0)}% of requests)`,
    ...base,
  }
}
