import { describe, expect, it } from 'vitest'
import { composeQuote, type ComponentResults } from './compose.js'

const now = new Date('2026-11-05T12:00:00Z')
const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()

const pricing = { basis: 'tariff' as const, contractId: null, contractVersion: null, tariffId: 'TRF-KCKCHI-GRAIN-CH', tariffVersion: 7, ratePerCarCents: 130_500, asOf: iso(86_400_000) }
const fuel = { effectiveDate: '2026-11-02', centsPerMile: 42, miles: 450, amountPerCarCents: 18_900, asOf: iso(3_600_000) }
const capacity = { snapshotId: 'cap-1', utilizationPct: 90, premiumPct: 7.5, transitDays: 3, asOf: iso(60_000) }
const availability = { snapshotId: 'avl-1', carsAvailable: 50, placementDays: 2, shortagePremiumCents: 0, asOf: iso(60_000) }

function allLive(): ComponentResults {
  return {
    pricing: { status: 'live', value: pricing, latencyMs: 60, shared: false, hedged: false },
    fuel: { status: 'live', value: fuel, latencyMs: 20, shared: false, hedged: false },
    capacity: { status: 'live', value: capacity, latencyMs: 130, shared: false, hedged: true },
    availability: { status: 'live', value: availability, latencyMs: 90, shared: false, hedged: false },
  }
}

const base = { quantity: 10, laneMiles: 450, now, rulesVersion: 'rules-test', staleness: { capacityMaxAgeSeconds: 1_800, availabilityMaxAgeSeconds: 1_800 }, validity: { indicativeMinutes: 15, firmHours: 24 } }

describe('composeQuote: firm vs indicative', () => {
  it('is firm when everything is live, and pins the inputs it used', () => {
    const q = composeQuote({ ...base, results: allLive() })
    if (q.kind === 'unavailable') throw new Error('unexpected')
    expect(q.kind).toBe('firm')
    const premium = Math.round((130_500 * 7.5) / 100)
    expect(q.totalCents).toBe((130_500 + 18_900 + premium) * 10)
    expect(q.band.lowCents).toBe(q.band.highCents)
    expect(q.inputs).toMatchObject({ pricingBasis: 'tariff', tariffVersion: 7, fuelSurchargeDate: '2026-11-02', capacitySnapshotId: 'cap-1', rulesVersion: 'rules-test' })
    expect(q.validUntil.getTime() - now.getTime()).toBe(24 * 3_600_000)
  })

  it('is still firm with a current cached tariff and surcharge (versioned inputs)', () => {
    const r = allLive()
    r.pricing = { status: 'cached', value: pricing, cachedAt: iso(30_000) }
    r.fuel = { status: 'cached', value: fuel, cachedAt: iso(30_000) }
    const q = composeQuote({ ...base, results: r })
    expect(q.kind).toBe('firm')
  })

  it('is indicative with a labeled snapshot when capacity misses its budget', () => {
    const r = allLive()
    r.capacity = { status: 'failed', reason: 'timeout', latencyMs: 600, fallback: { value: { ...capacity, asOf: iso(600_000) }, cachedAt: iso(600_000), current: true } }
    const q = composeQuote({ ...base, results: r })
    if (q.kind === 'unavailable') throw new Error('unexpected')
    expect(q.kind).toBe('indicative')
    expect(q.unconfirmed).toEqual(['capacity'])
    const cap = q.components.find((c) => c.dependency === 'capacity')!
    expect(cap.source).toBe('cache')
    expect(cap.ageSeconds).toBe(600)
    expect(cap.staleness).toMatch(/snapshot 10 min old/)
    expect(q.band.highCents).toBeGreaterThan(q.totalCents)
    expect(q.validUntil.getTime() - now.getTime()).toBe(15 * 60_000)
  })

  it('does not use a snapshot older than the staleness policy', () => {
    const r = allLive()
    r.capacity = { status: 'failed', reason: 'short_circuit', latencyMs: 0, fallback: { value: { ...capacity, asOf: iso(3_600_000) }, cachedAt: iso(3_600_000), current: true } }
    const q = composeQuote({ ...base, results: r })
    if (q.kind === 'unavailable') throw new Error('unexpected')
    const cap = q.components.find((c) => c.dependency === 'capacity')!
    expect(cap.source).toBe('fallback')
    expect(cap.amountCentsPerCar).toBe(0)
    expect(cap.staleness).toMatch(/circuit open/)
    expect(q.band.highCents - q.totalCents).toBe(Math.round((130_500 * 15) / 100) * 10)
  })

  it('refuses to quote when there is no linehaul price at all', () => {
    const r = allLive()
    r.pricing = { status: 'failed', reason: 'error', latencyMs: 5, fallback: null }
    const q = composeQuote({ ...base, results: r })
    expect(q.kind).toBe('unavailable')
  })

  it('labels a superseded fuel surcharge used as a fallback', () => {
    const r = allLive()
    r.fuel = { status: 'failed', reason: 'timeout', latencyMs: 250, fallback: { value: { ...fuel, effectiveDate: '2026-10-26' }, cachedAt: iso(700_000_000), current: false } }
    const q = composeQuote({ ...base, results: r })
    if (q.kind === 'unavailable') throw new Error('unexpected')
    expect(q.kind).toBe('indicative')
    expect(q.components.find((c) => c.dependency === 'fuel')!.staleness).toMatch(/may be superseded/)
  })

  it('prices a contract customer from the contract and records the contract version', () => {
    const r = allLive()
    r.pricing = { status: 'live', value: { ...pricing, basis: 'contract', contractId: 'CTR-PGC-2026', contractVersion: 3, ratePerCarCents: 118_000 }, latencyMs: 50, shared: false, hedged: false }
    const q = composeQuote({ ...base, results: r })
    if (q.kind === 'unavailable') throw new Error('unexpected')
    expect(q.inputs).toMatchObject({ pricingBasis: 'contract', contractId: 'CTR-PGC-2026', contractVersion: 3, tariffVersion: null })
    expect(q.components[0].basis).toBe('contract CTR-PGC-2026 v3')
  })
})
