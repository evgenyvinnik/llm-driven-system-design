import { describe, expect, it } from 'vitest'
import { decide, type DecideInput, type ModelSignal } from './decide.js'
import type { GateResult, RuleResult } from './types.js'

const IDS = ['bound_to_current_head', 'ci_green_at_head', 'required_reviewers_approved', 'no_protected_paths', 'within_size_limits', 'not_self_authored', 'no_ci_config_changes', 'no_policy_changes', 'no_opaque_files', 'category_in_scope'] as const

function gate(failed: (typeof IDS)[number][] = [], unknown: (typeof IDS)[number][] = []): GateResult {
  const rules: RuleResult[] = IDS.map((id) => ({ id, status: failed.includes(id) ? 'fail' : unknown.includes(id) ? 'unknown' : 'pass', reason: `${id} reason` }))
  return { policyVersion: 'test', category: 'docs', categoryReasons: [], rules, passed: failed.length === 0 && unknown.length === 0, failed, unknown }
}

const APPROVE: ModelSignal = { kind: 'assessment', verdict: 'approve', risk: 'low', confidence: 0.99 }
const input = (o: Partial<DecideInput> = {}): DecideInput => ({ mode: 'narrow_auto', killSwitch: false, gate: gate(), model: APPROVE, signals: { injection: false, toolDenied: false }, minConfidence: 0.8, ...o })

describe('decide', () => {
  it('approves only when the gate passes and the model is confident and low risk', () => {
    const r = decide(input())
    expect(r.outcome).toBe('auto_approved')
    expect(r.would).toBe('approve')
    expect(r.modelOverruled).toBe(false)
  })

  it.each(IDS.filter((id) => id !== 'ci_green_at_head'))('a confident model cannot override a failed %s', (rule) => {
    const r = decide(input({ gate: gate([rule]) }))
    expect(r.outcome).toBe('escalated')
    expect(r.reasonCode).toBe('gate_failed')
    expect(r.modelOverruled).toBe(true)
    expect(r.reason).toContain(rule)
  })

  it('a confident model cannot override red CI', () => {
    const r = decide(input({ gate: gate(['ci_green_at_head']) }))
    expect(r.outcome).toBe('escalated')
    expect(r.modelOverruled).toBe(true)
  })

  it('a risky model verdict escalates a passing gate', () => {
    const r = decide(input({ model: { kind: 'assessment', verdict: 'request_changes', risk: 'high', confidence: 0.9 } }))
    expect(r.outcome).toBe('escalated')
    expect(r.reasonCode).toBe('model_not_approved')
    expect(r.modelOverruled).toBe(false)
  })

  it('needs_human escalates', () => {
    expect(decide(input({ model: { kind: 'assessment', verdict: 'needs_human', risk: 'low', confidence: 0.9 } })).reasonCode).toBe('model_not_approved')
  })

  it('a model approve at medium risk escalates', () => {
    expect(decide(input({ model: { kind: 'assessment', verdict: 'approve', risk: 'medium', confidence: 0.99 } })).reasonCode).toBe('model_uncertain')
  })

  it('low confidence can lower the outcome', () => {
    expect(decide(input({ model: { kind: 'assessment', verdict: 'approve', risk: 'low', confidence: 0.5 } })).reasonCode).toBe('model_uncertain')
  })

  it('high confidence cannot raise it', () => {
    const confident: ModelSignal = { kind: 'assessment', verdict: 'needs_human', risk: 'low', confidence: 1 }
    expect(decide(input({ model: confident })).outcome).toBe('escalated')
  })

  it.each(['model_unavailable', 'model_timeout', 'model_malformed', 'model_not_called'] as const)('%s fails closed with a passing gate', (code) => {
    const r = decide(input({ model: { kind: 'failure', code, detail: 'x' } }))
    expect(r.outcome).toBe('escalated')
    expect(r.reasonCode).toBe(code)
  })

  it('missing facts other than CI fail closed', () => {
    const r = decide(input({ gate: gate([], ['within_size_limits']) }))
    expect(r.outcome).toBe('escalated')
    expect(r.reasonCode).toBe('missing_data')
  })

  it('waits for CI only when everything else is fine', () => {
    expect(decide(input({ gate: gate([], ['ci_green_at_head']) })).outcome).toBe('waiting_ci')
  })

  it('does not wait for CI if the model already said no', () => {
    const r = decide(input({ gate: gate([], ['ci_green_at_head']), model: { kind: 'assessment', verdict: 'request_changes', risk: 'high', confidence: 0.9 } }))
    expect(r.outcome).toBe('escalated')
  })

  it('missing CI fails closed once the deadline passes', () => {
    const r = decide(input({ gate: gate([], ['ci_green_at_head']), ciDeadlineExceeded: true }))
    expect(r.outcome).toBe('escalated')
    expect(r.reasonCode).toBe('ci_missing')
  })

  it('a denied tool request escalates', () => {
    expect(decide(input({ signals: { injection: false, toolDenied: true } })).reasonCode).toBe('tool_denied')
  })

  it('the scanner can escalate', () => {
    expect(decide(input({ signals: { injection: true, toolDenied: false } })).reasonCode).toBe('injection_signal')
  })

  it('a clean scan grants nothing: a failed rule still refuses', () => {
    const r = decide(input({ gate: gate(['category_in_scope']), signals: { injection: false, toolDenied: false } }))
    expect(r.outcome).toBe('escalated')
  })

  it('the kill switch stops an approval', () => {
    const r = decide(input({ killSwitch: true }))
    expect(r.outcome).toBe('escalated')
    expect(r.reasonCode).toBe('kill_switch')
    expect(r.would).toBe('approve')
  })

  it('observe never approves, whatever the input', () => {
    const r = decide(input({ mode: 'observe' }))
    expect(r.outcome).toBe('shadow')
    expect(r.would).toBe('approve')
    expect(decide(input({ mode: 'observe', gate: gate(['no_protected_paths']) })).outcome).toBe('shadow')
    expect(decide(input({ mode: 'observe', gate: gate(['no_protected_paths']) })).would).toBe('escalate')
  })

  it('exhaustive: no combination with a failed rule reaches an approval', () => {
    const models: ModelSignal[] = [APPROVE, { kind: 'assessment', verdict: 'needs_human', risk: 'low', confidence: 1 }, { kind: 'failure', code: 'model_timeout', detail: '' }]
    for (const mode of ['observe', 'narrow_auto'] as const) {
      for (const killSwitch of [false, true]) {
        for (const model of models) {
          for (const injection of [false, true]) {
            for (const toolDenied of [false, true]) {
              for (const id of IDS) {
                const r = decide({ mode, killSwitch, model, gate: gate([id]), signals: { injection, toolDenied }, minConfidence: 0.8 })
                expect(r.outcome).not.toBe('auto_approved')
                expect(r.would).toBe('escalate')
              }
            }
          }
        }
      }
    }
  })
})
