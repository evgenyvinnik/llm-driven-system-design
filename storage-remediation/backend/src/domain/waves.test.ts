import { describe, expect, it } from 'vitest'
import type { EvidenceClass, Ring } from './types.js'
import { DEFAULT_WAVES, planWaves, type PlanCandidate } from './waves.js'

function candidates(n: number, ring: Ring, subs = 10, evidence: EvidenceClass = 'safe_to_fix'): PlanCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    accountId: `${ring}-${String(i).padStart(4, '0')}`,
    subscriptionId: `${ring}-sub-${i % subs}`,
    ring,
    evidenceClass: evidence,
    exempt: false,
    traffic: (i * 37) % 500,
    riskScore: 50,
  }))
}

describe('wave planning', () => {
  it('runs every non-production wave before any production wave', () => {
    const plan = planWaves([...candidates(100, 'prod'), ...candidates(100, 'nonprod')])
    const rings = plan.waves.map((w) => w.ring)
    expect(rings.lastIndexOf('nonprod')).toBeLessThan(rings.indexOf('prod'))
    expect(plan.waves.map((w) => w.waveNo)).toEqual(plan.waves.map((_, i) => i + 1))
  })

  it('sizes the canary by percentage and spreads it across subscriptions', () => {
    const plan = planWaves(candidates(200, 'nonprod', 10))
    const canary = plan.waves[0]
    expect(canary.label).toBe('nonprod canary')
    expect(canary.accountIds).toHaveLength(10)
    expect(new Set(canary.accountIds.map((id) => `nonprod-sub-${Number(id.split('-')[1]) % 10}`)).size).toBe(10)
  })

  it('puts the quietest accounts first after the canary, and grows waves geometrically up to the cap', () => {
    const input = candidates(1000, 'nonprod', 25)
    const plan = planWaves(input, { ...DEFAULT_WAVES, maxWaveSize: 300 })
    expect(plan.waves.map((w) => w.accountIds.length)).toEqual([50, 200, 300, 300, 150])
    const traffic = new Map(input.map((c) => [c.accountId, c.traffic]))
    const wave2 = plan.waves[1].accountIds.map((id) => traffic.get(id)!)
    const wave3 = plan.waves[2].accountIds.map((id) => traffic.get(id)!)
    expect(Math.max(...wave2)).toBeLessThanOrEqual(Math.min(...wave3))
  })

  it('includes every eligible account exactly once', () => {
    const input = [...candidates(333, 'nonprod'), ...candidates(77, 'prod'), ...candidates(5, 'prod')]
    const ids = planWaves(input).waves.flatMap((w) => w.accountIds)
    expect(ids).toHaveLength(new Set(input.map((c) => c.accountId)).size)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('excludes exceptions and evidence classes the campaign did not opt into, with reasons', () => {
    const input = [...candidates(3, 'prod'), { ...candidates(1, 'prod')[0], accountId: 'x1', exempt: true }, { ...candidates(1, 'prod', 1, 'needs_owner_migration')[0], accountId: 'x2' }, { ...candidates(1, 'prod')[0], accountId: 'x3', evidenceClass: null }]
    const plan = planWaves(input)
    expect(plan.excluded).toEqual([
      { accountId: 'x1', reason: 'exception' },
      { accountId: 'x2', reason: 'needs_owner_migration' },
      { accountId: 'x3', reason: 'no_evidence_yet' },
    ])
    const opted = planWaves(input, { ...DEFAULT_WAVES, includeClasses: ['safe_to_fix', 'needs_owner_migration'] })
    expect(opted.waves.flatMap((w) => w.accountIds)).toContain('x2')
  })

  it('handles a single account', () => {
    expect(planWaves(candidates(1, 'prod')).waves).toEqual([{ waveNo: 1, ring: 'prod', label: 'prod canary', accountIds: ['prod-0000'] }])
  })
})
