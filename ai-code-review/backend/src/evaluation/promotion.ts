/**
 * The promotion gate: pure, every check reporting its own result, the same habit
 * as the policy gate. A repository leaves observe only when an evaluation of its
 * exact model version and the current policy version clears the thresholds, on
 * the full corpus, more recently than any demotion, and enough shadow decisions
 * have been recorded on its own traffic.
 * @module evaluation/promotion
 */
import { POLICY_VERSION } from '../shared/gate/rules.js'
import type { EvaluationSummary } from './metrics.js'

export interface PromotionThresholds {
  minCases: number
  minDangerousCases: number
  maxDangerousFalseApprovals: number
  maxDangerousUpperBound: number
  maxInScopeFalseEscalationRate: number
  minShadowDecisions: number
  minShadowAgreement: number
}

export interface PromotionEvidence {
  killSwitch: boolean
  modelVersion: string
  demotedAt: Date | null
  evaluation: { id: string; modelVersion: string; policyVersion: string; partial: boolean; createdAt: Date; summary: EvaluationSummary } | null
  shadow: { decisions: number; labeled: number; agreed: number; unsafeApprovals: number }
}

export interface PromotionCheck {
  id: string
  passed: boolean
  required: string
  actual: string
}

export function evaluatePromotion(e: PromotionEvidence, t: PromotionThresholds): { allowed: boolean; checks: PromotionCheck[]; reasons: string[] } {
  const checks: PromotionCheck[] = []
  const add = (id: string, passed: boolean, required: string, actual: string) => checks.push({ id, passed, required, actual })
  add('kill_switch_off', !e.killSwitch, 'Kill switch off', e.killSwitch ? 'On' : 'Off')

  const ev = e.evaluation
  add('evaluation_exists', ev !== null, `An evaluation of ${e.modelVersion} under policy ${POLICY_VERSION}`, ev ? ev.id : 'None')
  if (ev) {
    const m = ev.summary.modelPlusGate
    add('full_corpus', !ev.partial, 'The full corpus, not a partial run', ev.partial ? 'Partial' : 'Full')
    add('after_demotion', !e.demotedAt || ev.createdAt > e.demotedAt, 'Newer than the last demotion', e.demotedAt ? ev.createdAt.toISOString() : 'Never demoted')
    add('min_cases', ev.summary.corpus.size >= t.minCases, `At least ${t.minCases} labeled cases`, String(ev.summary.corpus.size))
    add('min_dangerous_cases', ev.summary.corpus.dangerous >= t.minDangerousCases, `At least ${t.minDangerousCases} dangerous cases`, String(ev.summary.corpus.dangerous))
    add('dangerous_false_approvals', m.dangerous.falseApprovals <= t.maxDangerousFalseApprovals, `At most ${t.maxDangerousFalseApprovals} dangerous false approvals`, String(m.dangerous.falseApprovals))
    add('dangerous_upper_bound', m.dangerous.upperBound95 <= t.maxDangerousUpperBound, `95% upper bound at most ${t.maxDangerousUpperBound}`, m.dangerous.upperBound95.toFixed(3))
    add('in_scope_false_escalations', m.falseEscalations.inScopeRate <= t.maxInScopeFalseEscalationRate, `In-scope false escalation rate at most ${t.maxInScopeFalseEscalationRate}`, m.falseEscalations.inScopeRate.toFixed(3))
  }

  add('min_shadow_decisions', e.shadow.decisions >= t.minShadowDecisions, `At least ${t.minShadowDecisions} shadow decisions on this repository`, String(e.shadow.decisions))
  if (e.shadow.labeled > 0) {
    const rate = e.shadow.agreed / e.shadow.labeled
    add('shadow_agreement', rate >= t.minShadowAgreement, `Shadow agreement with humans at least ${t.minShadowAgreement}`, `${e.shadow.agreed}/${e.shadow.labeled}`)
  }
  add('no_unsafe_shadow_approvals', e.shadow.unsafeApprovals === 0, 'No shadow approval that a human rejected', String(e.shadow.unsafeApprovals))

  const failed = checks.filter((c) => !c.passed)
  return { allowed: failed.length === 0, checks, reasons: failed.map((c) => `${c.id}: required ${c.required}, found ${c.actual}`) }
}
