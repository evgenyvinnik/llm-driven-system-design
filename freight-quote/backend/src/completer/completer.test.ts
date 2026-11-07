import { describe, expect, it } from 'vitest'
import { planCompletion } from './firm.js'
import { repriceComponents } from './invalidator.js'
import { nextBackoffMs } from './webhooks.js'
import { decide, PermanentError } from '../shared/consumer.js'
import type { PriceComponent } from '../shared/domain.js'

describe('firm completion is idempotent by quote state', () => {
  it('completes an open indicative quote', () => {
    expect(planCompletion(true, { kind: 'indicative', status: 'open' })).toBe('complete')
  })

  it('makes a redelivered QuoteRequested a no-op once the quote is firm', () => {
    // A completer killed after its commit and before XACK: the message comes back, the quote is already firm.
    expect(planCompletion(true, { kind: 'firm', status: 'open' })).toBe('already_firm')
    expect(planCompletion(true, { kind: 'firm', status: 'booked' })).toBe('already_firm')
  })

  it('skips quotes that expired or were booked before completion, and firm-at-issue quotes', () => {
    expect(planCompletion(true, { kind: 'indicative', status: 'expired' })).toBe('closed')
    expect(planCompletion(false, { kind: 'firm', status: 'open' })).toBe('not_needed')
  })

  it('dead-letters a QuoteRequested whose quote does not exist (permanent)', () => {
    let err: unknown
    try {
      planCompletion(true, null)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(PermanentError)
    expect(decide(err, 1)).toBe('dead_letter')
  })
})

const comp = (component: PriceComponent['component'], dependency: PriceComponent['dependency'], amount: number, extra: Partial<PriceComponent> = {}): PriceComponent => ({
  component, dependency, source: 'live', amountCentsPerCar: amount, basis: '', version: null, asOf: '', ageSeconds: 0, latencyMs: 10, staleness: null, detail: {}, ...extra,
})

describe('re-pricing open indicative quotes on TariffPublished / FuelSurchargeChanged', () => {
  it('replaces the linehaul and scales a confirmed capacity premium with it', () => {
    const before = [
      comp('linehaul', 'pricing', 100_000, { version: 'tariff:v7' }),
      comp('fuel_surcharge', 'fuel', 18_900),
      comp('capacity_premium', 'capacity', 5_000, { detail: { premiumPct: 5 } }),
      comp('equipment', 'availability', 0, { source: 'fallback' }),
    ]
    const r = repriceComponents(before, { linehaulCents: 103_000, tariffVersion: 8, tariffId: 'TRF-X', laneMiles: 450, asOf: '2026-11-05T00:00:00Z' })
    expect(r.components[0]).toMatchObject({ amountCentsPerCar: 103_000, version: 'tariff:v8' })
    expect(r.components[2].amountCentsPerCar).toBe(5_150)
    expect(r.deltaPerCar).toBe(3_000 + 150)
    expect(before[0].amountCentsPerCar).toBe(100_000)
  })

  it('widens the band when the capacity premium is still unconfirmed', () => {
    const before = [comp('linehaul', 'pricing', 100_000), comp('capacity_premium', 'capacity', 0, { source: 'fallback' })]
    const r = repriceComponents(before, { linehaulCents: 110_000, tariffVersion: 8, tariffId: 'TRF-X', laneMiles: 450, asOf: '' })
    expect(r.bandHighDeltaPerCar).toBe(Math.round((10_000 * 15) / 100))
  })

  it('recomputes the fuel surcharge from lane miles', () => {
    const r = repriceComponents([comp('fuel_surcharge', 'fuel', 18_900, { source: 'fallback', staleness: 'old' })], { fuelCentsPerMile: 45, fuelDate: '2026-11-09', laneMiles: 450, asOf: '' })
    expect(r.components[0]).toMatchObject({ amountCentsPerCar: 20_250, source: 'live', staleness: null, version: 'fsc:2026-11-09' })
    expect(r.deltaPerCar).toBe(1_350)
  })
})

describe('webhook retry backoff', () => {
  it('grows exponentially with jitter, capped at a minute', () => {
    expect(nextBackoffMs(1, 1_000, () => 0)).toBe(500)
    expect(nextBackoffMs(1, 1_000, () => 1)).toBe(1_000)
    expect(nextBackoffMs(4, 1_000, () => 1)).toBe(8_000)
    expect(nextBackoffMs(20, 1_000, () => 1)).toBe(60_000)
  })
})
