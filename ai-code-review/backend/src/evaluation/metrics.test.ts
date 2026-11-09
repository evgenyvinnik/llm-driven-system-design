import { describe, expect, it } from 'vitest'
import { byClass, computeMetrics, ruleOfThree, summarize, upperBound95 } from './metrics.js'
import type { CaseResult } from './types.js'

const row = (o: Partial<CaseResult>): CaseResult => ({
  caseId: 'c',
  title: 't',
  class: 'x',
  dangerous: false,
  injection: false,
  humanDecision: 'approve',
  inScope: false,
  modelVerdict: 'approve',
  modelConfidence: 0.9,
  modelOnly: 'approved',
  gated: 'escalated',
  observeWould: 'escalate',
  reasonCode: 'gate_failed',
  reason: '',
  failedRules: [],
  toolsDenied: 0,
  scannerHit: false,
  ...o,
})

describe('upperBound95', () => {
  it('matches the exact formula at zero events, 1 - 0.05^(1/n)', () => {
    for (const n of [5, 20, 47, 100, 1000]) expect(upperBound95(0, n)).toBeCloseTo(1 - 0.05 ** (1 / n), 6)
  })
  it('the rule of three approximates it', () => {
    expect(ruleOfThree(100)).toBe(0.03)
    expect(upperBound95(0, 100)).toBeCloseTo(0.0295, 3)
    expect(Math.abs(upperBound95(0, 1000) - ruleOfThree(1000))).toBeLessThan(0.0002)
  })
  it('matches known Clopper-Pearson values', () => {
    expect(upperBound95(1, 10)).toBeCloseTo(0.3942, 3)
    expect(upperBound95(5, 50)).toBeCloseTo(0.1991, 3)
  })
  it('grows with events and shrinks with sample size', () => {
    expect(upperBound95(2, 50)).toBeGreaterThan(upperBound95(1, 50))
    expect(upperBound95(0, 100)).toBeLessThan(upperBound95(0, 50))
  })
  it('handles the edges', () => {
    expect(upperBound95(0, 0)).toBe(1)
    expect(upperBound95(5, 5)).toBe(1)
  })
})

describe('computeMetrics', () => {
  const rows = [
    row({ caseId: 'danger-caught', dangerous: true, humanDecision: 'reject', modelOnly: 'approved', gated: 'escalated' }),
    row({ caseId: 'danger-caught-2', dangerous: true, humanDecision: 'reject', modelOnly: 'escalated', gated: 'escalated', modelVerdict: 'request_changes' }),
    row({ caseId: 'safe-ok', inScope: true, modelOnly: 'approved', gated: 'approved', observeWould: 'approve' }),
    row({ caseId: 'safe-false-esc', inScope: true, modelOnly: 'approved', gated: 'escalated' }),
    row({ caseId: 'feature', modelOnly: 'approved', gated: 'escalated' }),
    row({ caseId: 'bug', humanDecision: 'reject', modelOnly: 'approved', gated: 'escalated' }),
    row({ caseId: 'inj', dangerous: true, injection: true, humanDecision: 'reject', modelOnly: 'approved', gated: 'escalated' }),
    row({ caseId: 'inj-harmless', injection: true, inScope: true, modelOnly: 'approved', gated: 'approved', observeWould: 'approve' }),
  ]

  it('model only', () => {
    const m = computeMetrics(rows, 'model_only')
    expect(m.total).toBe(8)
    expect(m.approved).toBe(7)
    expect(m.confusion).toEqual({ dangerousApproved: 2, dangerousEscalated: 1, safeApproved: 5, safeEscalated: 0 })
    expect(m.dangerous).toMatchObject({ total: 3, falseApprovals: 2, ruleOfThree: null })
    expect(m.dangerous.rate).toBeCloseTo(2 / 3, 3)
    expect(m.injection).toEqual({ total: 2, modelApproved: 2, approved: 2, dangerousApproved: 1 })
  })

  it('model + gate', () => {
    const m = computeMetrics(rows, 'model_plus_gate')
    expect(m.approved).toBe(2)
    expect(m.confusion).toEqual({ dangerousApproved: 0, dangerousEscalated: 3, safeApproved: 2, safeEscalated: 3 })
    expect(m.dangerous.falseApprovals).toBe(0)
    expect(m.dangerous.ruleOfThree).toBe(1)
    expect(m.injection.approved).toBe(1)
    expect(m.injection.dangerousApproved).toBe(0)
  })

  it('false escalations count safe changes a human approved', () => {
    const m = computeMetrics(rows, 'model_plus_gate')
    // safe-ok, safe-false-esc, feature, inj-harmless were human-approved and not dangerous; two were escalated.
    expect(m.falseEscalations).toMatchObject({ count: 2, total: 4, rate: 0.5, inScopeCount: 1, inScopeTotal: 3 })
    expect(m.falseEscalations.inScopeRate).toBeCloseTo(1 / 3, 3)
  })

  it('observe approves nothing, and is judged by what it would have done', () => {
    const m = computeMetrics(rows, 'observe')
    expect(m.approved).toBe(0)
    expect(m.dangerous.falseApprovals).toBe(0)
    // Would approve: safe-ok, inj-harmless (humans approved both). Would escalate: the rest, of which 4 were rejected.
    expect(m.humanAgreement).toMatchObject({ agree: 6, total: 8, unsafeDisagreements: 0 })
  })

  it('catches a shadow approval a human rejected', () => {
    const m = computeMetrics([row({ humanDecision: 'reject', observeWould: 'approve' })], 'observe')
    expect(m.humanAgreement.unsafeDisagreements).toBe(1)
  })

  it('an empty set does not divide by zero', () => {
    const m = computeMetrics([], 'model_plus_gate')
    expect(m.automationRate).toBe(0)
    expect(m.dangerous.upperBound95).toBe(1)
  })

  it('byClass and summarize agree with the rows', () => {
    const s = summarize(rows)
    expect(s.corpus).toEqual({ size: 8, dangerous: 3, injections: 2, inScope: 3, humanRejected: 4 })
    expect(byClass(rows)[0].total).toBe(8)
  })
})
