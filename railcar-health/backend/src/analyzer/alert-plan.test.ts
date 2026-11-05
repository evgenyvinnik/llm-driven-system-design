import { describe, expect, it } from 'vitest'
import { TIER } from '../shared/domain.js'
import { needsHold, planAlertChange } from './alert-plan.js'

describe('alert lifecycle', () => {
  it('opens an alert only at LOW or above', () => {
    expect(planAlertChange(null, TIER.NONE)).toEqual({ action: 'none' })
    expect(planAlertChange(null, TIER.MEDIUM)).toEqual({ action: 'open', tier: TIER.MEDIUM })
  })

  it('escalates the existing alert in place instead of opening a duplicate', () => {
    expect(planAlertChange({ tier: TIER.MEDIUM, status: 'open' }, TIER.HIGH)).toEqual({ action: 'escalate', from: TIER.MEDIUM, tier: TIER.HIGH, reopen: false })
  })

  it('reopens an acknowledged alert when it escalates, so the dispatcher sees the change', () => {
    expect(planAlertChange({ tier: TIER.HIGH, status: 'acknowledged' }, TIER.CRITICAL)).toMatchObject({ action: 'escalate', reopen: true })
  })

  it('never de-escalates on cooler readings; a human closes the alert', () => {
    expect(planAlertChange({ tier: TIER.HIGH, status: 'open' }, TIER.LOW)).toEqual({ action: 'refresh', tier: TIER.HIGH })
    expect(planAlertChange({ tier: TIER.HIGH, status: 'open' }, TIER.NONE)).toEqual({ action: 'refresh', tier: TIER.HIGH })
  })

  it('is idempotent: the same score against the same alert changes nothing', () => {
    const existing = { tier: TIER.MEDIUM, status: 'open' as const }
    expect(planAlertChange(existing, TIER.MEDIUM)).toEqual(planAlertChange(existing, TIER.MEDIUM))
    expect(planAlertChange(existing, TIER.MEDIUM).action).toBe('refresh')
  })

  it('opens a fresh alert after the previous one for the bearing was closed', () => {
    expect(planAlertChange({ tier: TIER.MEDIUM, status: 'closed' }, TIER.HIGH)).toEqual({ action: 'open', tier: TIER.HIGH })
  })

  it('holds cars from MEDIUM up', () => {
    expect(needsHold(TIER.LOW)).toBe(false)
    expect(needsHold(TIER.MEDIUM)).toBe(true)
  })
})
