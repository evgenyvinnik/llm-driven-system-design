/**
 * Plan stability. A re-plan computes the optimum from scratch, then re-prices
 * the current plan under the same new inputs. The current plan is replaced only
 * if it has become unsafe or the new one is better by a clear margin, so small
 * forecast wiggles don't flip the crew's instructions back and forth.
 * @module planner/hysteresis
 */
import type { SimResult } from './types.js'
import { stopSignature } from './optimizer.js'

export interface HysteresisParams {
  hysteresisAbs: number
  hysteresisPct: number
}

export type Decision = 'initial' | 'switch_unsafe' | 'switch_savings' | 'keep_same' | 'keep_within_band'

export interface HysteresisOutcome {
  decision: Decision
  switched: boolean
  savings: number
  threshold: number
  explanation: string
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

export function decide(incumbent: SimResult | null, candidate: SimResult, params: HysteresisParams): HysteresisOutcome {
  if (!incumbent) {
    return { decision: 'initial', switched: true, savings: 0, threshold: 0, explanation: `First plan for this trip: ${stopSignature(candidate.stops)}` }
  }
  const threshold = Math.max(params.hysteresisAbs, params.hysteresisPct * Math.abs(incumbent.cost.total))
  const savings = incumbent.cost.total - candidate.cost.total
  if (!incumbent.feasible) {
    const why = incumbent.breach
      ? `the current plan would leave a unit below reserve at ${incumbent.breach.name}`
      : `the current plan relies on an option that is no longer usable (${incumbent.unavailable.join('; ')})`
    return { decision: 'switch_unsafe', switched: true, savings, threshold, explanation: `Replanned because ${why}` }
  }
  if (stopSignature(incumbent.stops) === stopSignature(candidate.stops)) {
    return { decision: 'keep_same', switched: false, savings, threshold, explanation: 'Optimal stops are unchanged; gallons were re-estimated' }
  }
  if (savings > threshold) {
    return {
      decision: 'switch_savings',
      switched: true,
      savings,
      threshold,
      explanation: `New plan saves ${money(savings)} (threshold ${money(threshold)}): ${stopSignature(candidate.stops)}`,
    }
  }
  return {
    decision: 'keep_within_band',
    switched: false,
    savings,
    threshold,
    explanation:
      savings <= 0
        ? `Kept the current plan: it is still as good as the best alternative (${stopSignature(candidate.stops)})`
        : `Kept the current plan: the alternative (${stopSignature(candidate.stops)}) saves only ${money(savings)}, under the ${money(threshold)} threshold`,
  }
}
