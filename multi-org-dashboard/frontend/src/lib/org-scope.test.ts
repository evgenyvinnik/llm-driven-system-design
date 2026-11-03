import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateOrg, assertStillActive, droppedResponseCount, scopeSignal, StaleOrgResponse } from './org-scope'

beforeEach(() => {
  activateOrg(null)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

describe('org scope', () => {
  it('aborts the old org’s requests when switching', () => {
    activateOrg('org_lumen')
    const signal = scopeSignal()
    expect(signal.aborted).toBe(false)
    activateOrg('org_harbor')
    expect(signal.aborted).toBe(true)
    expect(scopeSignal().aborted).toBe(false)
  })

  it('drops a response that arrives after the switch', () => {
    activateOrg('org_lumen')
    const before = droppedResponseCount()
    activateOrg('org_harbor')
    expect(() => assertStillActive('org_lumen', '/conversations')).toThrow(StaleOrgResponse)
    expect(droppedResponseCount()).toBe(before + 1)
    expect(() => assertStillActive('org_harbor', '/conversations')).not.toThrow()
  })

  it('does nothing when re-activating the same org', () => {
    activateOrg('org_lumen')
    const signal = scopeSignal()
    expect(activateOrg('org_lumen')).toBeNull()
    expect(signal.aborted).toBe(false)
  })
})
