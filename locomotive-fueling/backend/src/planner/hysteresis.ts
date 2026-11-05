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
  /** Extra savings required to change a plan someone has accepted. */
  acceptedChangeCost: number
}

export interface DecideContext {
  /** The plan in force has been accepted by the fuel desk or crew. */
  accepted: boolean
}

/**
 * - switch_unsafe: the plan in force breaches reserve or uses a dead option; replaced now (an
 *   accepted plan is voided and the replacement must be accepted again).
 * - switch_savings: recommended plan replaced by a clearly cheaper one.
 * - propose_change: accepted plan, clearly cheaper alternative: stored as a proposal; the fuel
 *   desk must confirm before anything changes.
 */
export type Decision = 'initial' | 'switch_unsafe' | 'switch_savings' | 'propose_change' | 'keep_same' | 'keep_within_band'

export interface HysteresisOutcome {
  decision: Decision
  switched: boolean
  savings: number
  threshold: number
  explanation: string
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

export function decide(incumbent: SimResult | null, candidate: SimResult, params: HysteresisParams, ctx: DecideContext = { accepted: false }): HysteresisOutcome {
  if (!incumbent) {
    return { decision: 'initial', switched: true, savings: 0, threshold: 0, explanation: `First plan for this trip: ${stopSignature(candidate.stops)}` }
  }
  const threshold = Math.max(params.hysteresisAbs, params.hysteresisPct * Math.abs(incumbent.cost.total)) + (ctx.accepted ? params.acceptedChangeCost : 0)
  const savings = incumbent.cost.total - candidate.cost.total
  if (!incumbent.feasible) {
    const why = incumbent.breach
      ? `the current plan would leave a unit below reserve at ${incumbent.breach.name}`
      : `the current plan relies on an option that is no longer usable (${incumbent.unavailable.join('; ')})`
    const voided = ctx.accepted ? ' The accepted plan is void; the replacement needs acceptance.' : ''
    return { decision: 'switch_unsafe', switched: true, savings, threshold, explanation: `Replanned because ${why}.${voided}` }
  }
  if (stopSignature(incumbent.stops) === stopSignature(candidate.stops)) {
    return { decision: 'keep_same', switched: false, savings, threshold, explanation: 'Optimal stops are unchanged; gallons were re-estimated' }
  }
  if (savings > threshold && ctx.accepted) {
    return {
      decision: 'propose_change',
      switched: false,
      savings,
      threshold,
      explanation: `Cheaper plan found after acceptance: saves ${money(savings)} (bar ${money(threshold)} incl. ${money(params.acceptedChangeCost)} change cost): ${stopSignature(candidate.stops)}. Awaiting fuel desk confirmation`,
    }
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
