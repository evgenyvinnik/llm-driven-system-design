/**
 * The only place model output meets the gate, and the shape of the code is the
 * argument: every branch that reads the model can only move the outcome toward
 * a human. No path starts from a failed rule and ends at approve.
 * @module shared/gate/decide
 */
import type { GateResult, RepoMode } from './types.js'

export type ModelSignal =
  | { kind: 'assessment'; verdict: 'approve' | 'needs_human' | 'request_changes'; risk: 'low' | 'medium' | 'high'; confidence: number }
  | { kind: 'failure'; code: 'model_unavailable' | 'model_timeout' | 'model_malformed' | 'model_not_called'; detail: string }

export interface DecideInput {
  mode: RepoMode
  killSwitch: boolean
  gate: GateResult
  model: ModelSignal
  signals: { injection: boolean; toolDenied: boolean }
  minConfidence: number
  /** The CI wait ran out, so missing results now fail closed instead of waiting. */
  ciDeadlineExceeded?: boolean
}

export type Would = 'approve' | 'escalate' | 'wait_ci'
export type Outcome = 'auto_approved' | 'escalated' | 'shadow' | 'waiting_ci'

export type ReasonCode =
  | 'all_checks_passed'
  | 'gate_failed'
  | 'missing_data'
  | 'ci_pending'
  | 'ci_missing'
  | 'model_unavailable'
  | 'model_timeout'
  | 'model_malformed'
  | 'model_not_called'
  | 'model_not_approved'
  | 'model_uncertain'
  | 'tool_denied'
  | 'injection_signal'
  | 'kill_switch'
  | 'post_failed'

export interface DecisionResult {
  would: Would
  outcome: Outcome
  reasonCode: ReasonCode
  reason: string
  /** The model approved and the gate said no. Each one is an alarm worth counting. */
  modelOverruled: boolean
}

interface Judgement {
  would: Would
  reasonCode: ReasonCode
  reason: string
}

function judge(input: DecideInput): Judgement {
  const { gate, model, signals } = input
  const escalate = (reasonCode: ReasonCode, reason: string): Judgement => ({ would: 'escalate', reasonCode, reason })

  if (gate.failed.length > 0) {
    const first = gate.rules.find((r) => r.id === gate.failed[0])
    const extra = gate.failed.length > 1 ? ` (and ${gate.failed.length - 1} more rule${gate.failed.length > 2 ? 's' : ''})` : ''
    return escalate('gate_failed', `${gate.failed[0]}: ${first?.reason ?? 'failed'}${extra}`)
  }
  const missing = gate.unknown.filter((id) => id !== 'ci_green_at_head')
  if (missing.length > 0) return escalate('missing_data', `Facts unavailable for ${missing.join(', ')}`)

  if (model.kind === 'failure') return escalate(model.code, model.detail)
  if (signals.toolDenied) return escalate('tool_denied', 'The model asked for a tool or path outside its allowlist')
  if (signals.injection) return escalate('injection_signal', 'The scanner matched injection phrasing in untrusted content')
  if (model.verdict !== 'approve') return escalate('model_not_approved', `The model's verdict is ${model.verdict} at ${model.risk} risk`)
  if (model.risk !== 'low') return escalate('model_uncertain', `The model approved, but rates this ${model.risk} risk`)
  if (model.confidence < input.minConfidence) return escalate('model_uncertain', `The model's confidence ${model.confidence.toFixed(2)} is below ${input.minConfidence}`)

  if (gate.unknown.includes('ci_green_at_head')) {
    const rule = gate.rules.find((r) => r.id === 'ci_green_at_head')
    if (input.ciDeadlineExceeded) return escalate('ci_missing', `CI never reported: ${rule?.reason ?? 'no results'}`)
    return { would: 'wait_ci', reasonCode: 'ci_pending', reason: rule?.reason ?? 'Waiting for CI' }
  }
  return { would: 'approve', reasonCode: 'all_checks_passed', reason: 'Every rule passed and the model approved at low risk' }
}

export function decide(input: DecideInput): DecisionResult {
  const j = judge(input)
  const modelApproved = input.model.kind === 'assessment' && input.model.verdict === 'approve'
  const base = { would: j.would, reasonCode: j.reasonCode, reason: j.reason, modelOverruled: modelApproved && input.gate.failed.length > 0 }

  if (j.would === 'wait_ci') return { ...base, outcome: 'waiting_ci' }
  // Observe never approves and queues nothing: humans are still reviewing normally.
  if (input.mode === 'observe') return { ...base, outcome: 'shadow' }
  if (j.would === 'escalate') return { ...base, outcome: 'escalated' }
  if (input.killSwitch) return { ...base, outcome: 'escalated', reasonCode: 'kill_switch', reason: 'The repository kill switch is on' }
  return { ...base, outcome: 'auto_approved' }
}
