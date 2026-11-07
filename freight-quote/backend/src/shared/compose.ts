/**
 * Turns the four component results into a quote. Pure, so the firm vs
 * indicative rules are unit-tested without any I/O.
 *
 * The rules, in the order they bite:
 *  1. No linehaul (pricing failed and no current cached version) means no quote.
 *     A superseded tariff is never served, and a price is never invented.
 *  2. Firm requires a live or current-version linehaul and fuel surcharge, and
 *     a live capacity and car-supply answer.
 *  3. Otherwise the quote is indicative. Each non-live component says what it
 *     is (cached snapshot and its age, superseded surcharge, or unconfirmed),
 *     and the price band widens by the most that component could add.
 * @module shared/compose
 */
import type { Answers, FailureKind } from './dependency-client.js'
import {
  COMPONENT_OF,
  MAX_CAPACITY_PREMIUM_PCT,
  MAX_EQUIPMENT_PREMIUM_CENTS,
  type Dependency,
  type PriceBand,
  type PriceComponent,
  type QuoteInputs,
  type QuoteKind,
} from './domain.js'

export type ComponentResult<D extends Dependency> =
  | { status: 'live'; value: Answers[D]; latencyMs: number; shared: boolean; hedged: boolean }
  | { status: 'cached'; value: Answers[D]; cachedAt: string }
  | { status: 'failed'; reason: FailureKind; latencyMs: number; fallback: { value: Answers[D]; cachedAt: string; current: boolean } | null }

export interface ComponentResults {
  pricing: ComponentResult<'pricing'>
  fuel: ComponentResult<'fuel'>
  capacity: ComponentResult<'capacity'>
  availability: ComponentResult<'availability'>
}

export interface ComposeInput {
  quantity: number
  laneMiles: number
  results: ComponentResults
  now: Date
  rulesVersion: string
  staleness: { capacityMaxAgeSeconds: number; availabilityMaxAgeSeconds: number }
  validity: { indicativeMinutes: number; firmHours: number }
}

export type ComposeOutcome =
  | { kind: 'unavailable'; reason: string; failed: Dependency[] }
  | {
      kind: QuoteKind
      components: PriceComponent[]
      totalCents: number
      band: PriceBand
      inputs: QuoteInputs
      validUntil: Date
      /** Components that kept the quote from being firm. */
      unconfirmed: Dependency[]
    }

const ageSeconds = (now: Date, iso: string) => Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))

function fmtAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

function failureText(reason: FailureKind): string {
  switch (reason) {
    case 'timeout':
    case 'deadline':
      return 'did not answer within its budget'
    case 'short_circuit':
      return 'circuit open'
    case 'rejected':
      return 'rejected the request'
    default:
      return 'failed'
  }
}

export function composeQuote(input: ComposeInput): ComposeOutcome {
  const { results, now, quantity } = input
  const r = results

  // 1. Linehaul.
  const pricing = r.pricing.status === 'failed' ? null : r.pricing
  if (!pricing) {
    return { kind: 'unavailable', reason: `pricing ${failureText((r.pricing as { reason: FailureKind }).reason)} and no current cached price exists`, failed: ['pricing'] }
  }
  const p = pricing.value
  const linehaul: PriceComponent = {
    component: COMPONENT_OF.pricing,
    dependency: 'pricing',
    source: pricing.status === 'live' ? 'live' : 'cache',
    amountCentsPerCar: p.ratePerCarCents,
    basis: p.basis === 'contract' ? `contract ${p.contractId} v${p.contractVersion}` : `tariff ${p.tariffId} v${p.tariffVersion}`,
    version: p.basis === 'contract' ? `contract:${p.contractId}:v${p.contractVersion}` : `tariff:v${p.tariffVersion}`,
    asOf: p.asOf,
    ageSeconds: pricing.status === 'live' ? 0 : ageSeconds(now, pricing.cachedAt),
    latencyMs: pricing.status === 'live' ? pricing.latencyMs : null,
    staleness: null,
    detail: { basis: p.basis, tariffId: p.tariffId, tariffVersion: p.tariffVersion, contractId: p.contractId, servedFromCache: pricing.status === 'cached' },
  }

  const unconfirmed: Dependency[] = []
  let bandLowPerCar = 0
  let bandHighPerCar = 0

  // 2. Fuel surcharge: live or current cache is authoritative; a superseded week is an estimate.
  let fuel: PriceComponent
  let fuelValue: Answers['fuel'] | null = null
  if (r.fuel.status !== 'failed') {
    fuelValue = r.fuel.value
    fuel = {
      component: COMPONENT_OF.fuel,
      dependency: 'fuel',
      source: r.fuel.status === 'live' ? 'live' : 'cache',
      amountCentsPerCar: fuelValue.amountPerCarCents,
      basis: `fuel surcharge, week of ${fuelValue.effectiveDate}`,
      version: `fsc:${fuelValue.effectiveDate}`,
      asOf: fuelValue.asOf,
      ageSeconds: r.fuel.status === 'live' ? 0 : ageSeconds(now, r.fuel.cachedAt),
      latencyMs: r.fuel.status === 'live' ? r.fuel.latencyMs : null,
      staleness: null,
      detail: { centsPerMile: fuelValue.centsPerMile, miles: fuelValue.miles },
    }
  } else if (r.fuel.fallback) {
    fuelValue = r.fuel.fallback.value
    unconfirmed.push('fuel')
    const amount = fuelValue.amountPerCarCents
    bandLowPerCar -= Math.round(amount * 0.1)
    bandHighPerCar += Math.round(amount * 0.1)
    fuel = {
      component: COMPONENT_OF.fuel,
      dependency: 'fuel',
      source: 'fallback',
      amountCentsPerCar: amount,
      basis: `fuel surcharge, week of ${fuelValue.effectiveDate}`,
      version: `fsc:${fuelValue.effectiveDate}`,
      asOf: fuelValue.asOf,
      ageSeconds: ageSeconds(now, r.fuel.fallback.cachedAt),
      latencyMs: null,
      staleness: r.fuel.fallback.current
        ? `Fuel service ${failureText(r.fuel.reason)}; using this week's cached surcharge`
        : `Fuel service ${failureText(r.fuel.reason)}; surcharge for week of ${fuelValue.effectiveDate} may be superseded (±10%)`,
      detail: { centsPerMile: fuelValue.centsPerMile, miles: fuelValue.miles },
    }
  } else {
    unconfirmed.push('fuel')
    const estimate = Math.round(input.laneMiles * 60)
    bandHighPerCar += estimate
    fuel = {
      component: COMPONENT_OF.fuel,
      dependency: 'fuel',
      source: 'fallback',
      amountCentsPerCar: 0,
      basis: 'fuel surcharge not confirmed',
      version: null,
      asOf: now.toISOString(),
      ageSeconds: 0,
      latencyMs: null,
      staleness: `Fuel service ${failureText(r.fuel.reason)}; surcharge not included (up to ${estimate / 100} USD per car)`,
      detail: {},
    }
  }

  // 3. Capacity premium (perishable).
  const capMax = Math.round((p.ratePerCarCents * MAX_CAPACITY_PREMIUM_PCT) / 100)
  let capacity: PriceComponent
  let capacitySnapshot: string | null = null
  if (r.capacity.status === 'live') {
    const c = r.capacity.value
    capacitySnapshot = c.snapshotId
    capacity = {
      component: COMPONENT_OF.capacity,
      dependency: 'capacity',
      source: 'live',
      amountCentsPerCar: Math.round((p.ratePerCarCents * c.premiumPct) / 100),
      basis: `capacity snapshot ${c.snapshotId}`,
      version: c.snapshotId,
      asOf: c.asOf,
      ageSeconds: 0,
      latencyMs: r.capacity.latencyMs,
      staleness: null,
      detail: { utilizationPct: c.utilizationPct, premiumPct: c.premiumPct, transitDays: c.transitDays, hedged: r.capacity.hedged, coalesced: r.capacity.shared },
    }
  } else {
    unconfirmed.push('capacity')
    const reason = r.capacity.status === 'failed' ? failureText(r.capacity.reason) : 'not checked'
    const fb = r.capacity.status === 'failed' ? r.capacity.fallback : null
    const age = fb ? ageSeconds(now, fb.value.asOf) : null
    if (fb && age !== null && age <= input.staleness.capacityMaxAgeSeconds) {
      const c = fb.value
      capacitySnapshot = c.snapshotId
      const amount = Math.round((p.ratePerCarCents * c.premiumPct) / 100)
      bandLowPerCar -= amount
      bandHighPerCar += capMax - amount
      capacity = {
        component: COMPONENT_OF.capacity,
        dependency: 'capacity',
        source: 'cache',
        amountCentsPerCar: amount,
        basis: `capacity snapshot ${c.snapshotId}`,
        version: c.snapshotId,
        asOf: c.asOf,
        ageSeconds: age,
        latencyMs: null,
        staleness: `Capacity service ${reason}; using a snapshot ${fmtAge(age)} old (policy max ${fmtAge(input.staleness.capacityMaxAgeSeconds)})`,
        detail: { utilizationPct: c.utilizationPct, premiumPct: c.premiumPct, transitDays: c.transitDays },
      }
    } else {
      bandHighPerCar += capMax
      capacity = {
        component: COMPONENT_OF.capacity,
        dependency: 'capacity',
        source: 'fallback',
        amountCentsPerCar: 0,
        basis: 'capacity not confirmed',
        version: null,
        asOf: now.toISOString(),
        ageSeconds: 0,
        latencyMs: null,
        staleness: `Capacity service ${reason}; no snapshot within policy. Firm price may add up to ${MAX_CAPACITY_PREMIUM_PCT}%`,
        detail: {},
      }
    }
  }

  // 4. Equipment (car supply, perishable).
  let equipment: PriceComponent
  let availabilitySnapshot: string | null = null
  if (r.availability.status === 'live') {
    const a = r.availability.value
    availabilitySnapshot = a.snapshotId
    equipment = {
      component: COMPONENT_OF.availability,
      dependency: 'availability',
      source: 'live',
      amountCentsPerCar: a.shortagePremiumCents,
      basis: `car supply snapshot ${a.snapshotId}`,
      version: a.snapshotId,
      asOf: a.asOf,
      ageSeconds: 0,
      latencyMs: r.availability.latencyMs,
      staleness: null,
      detail: { carsAvailable: a.carsAvailable, placementDays: a.placementDays, hedged: r.availability.hedged, coalesced: r.availability.shared },
    }
  } else {
    unconfirmed.push('availability')
    const reason = r.availability.status === 'failed' ? failureText(r.availability.reason) : 'not checked'
    const fb = r.availability.status === 'failed' ? r.availability.fallback : null
    const age = fb ? ageSeconds(now, fb.value.asOf) : null
    if (fb && age !== null && age <= input.staleness.availabilityMaxAgeSeconds) {
      const a = fb.value
      availabilitySnapshot = a.snapshotId
      bandLowPerCar -= a.shortagePremiumCents
      bandHighPerCar += MAX_EQUIPMENT_PREMIUM_CENTS - a.shortagePremiumCents
      equipment = {
        component: COMPONENT_OF.availability,
        dependency: 'availability',
        source: 'cache',
        amountCentsPerCar: a.shortagePremiumCents,
        basis: `car supply snapshot ${a.snapshotId}`,
        version: a.snapshotId,
        asOf: a.asOf,
        ageSeconds: age,
        latencyMs: null,
        staleness: `Car supply service ${reason}; using a snapshot ${fmtAge(age)} old (policy max ${fmtAge(input.staleness.availabilityMaxAgeSeconds)})`,
        detail: { carsAvailable: a.carsAvailable, placementDays: a.placementDays },
      }
    } else {
      bandHighPerCar += MAX_EQUIPMENT_PREMIUM_CENTS
      equipment = {
        component: COMPONENT_OF.availability,
        dependency: 'availability',
        source: 'fallback',
        amountCentsPerCar: 0,
        basis: 'car supply not confirmed',
        version: null,
        asOf: now.toISOString(),
        ageSeconds: 0,
        latencyMs: null,
        staleness: `Car supply service ${reason}; a shortage could add up to ${MAX_EQUIPMENT_PREMIUM_CENTS / 100} USD per car`,
        detail: {},
      }
    }
  }

  const components = [linehaul, fuel, capacity, equipment]
  const perCar = components.reduce((sum, c) => sum + c.amountCentsPerCar, 0)
  const totalCents = perCar * quantity
  const kind: QuoteKind = unconfirmed.length === 0 ? 'firm' : 'indicative'
  const band = kind === 'firm' ? { lowCents: totalCents, highCents: totalCents } : { lowCents: totalCents + bandLowPerCar * quantity, highCents: totalCents + bandHighPerCar * quantity }
  const validUntil =
    kind === 'firm'
      ? new Date(now.getTime() + input.validity.firmHours * 3_600_000)
      : new Date(now.getTime() + input.validity.indicativeMinutes * 60_000)

  const inputs: QuoteInputs = {
    pricingBasis: p.basis,
    tariffId: p.tariffId,
    tariffVersion: p.basis === 'tariff' ? p.tariffVersion : null,
    contractId: p.contractId,
    contractVersion: p.contractVersion,
    fuelSurchargeDate: fuelValue?.effectiveDate ?? null,
    fuelCentsPerMile: fuelValue?.centsPerMile ?? null,
    capacitySnapshotId: capacitySnapshot,
    availabilitySnapshotId: availabilitySnapshot,
    laneMiles: input.laneMiles,
    rulesVersion: input.rulesVersion,
  }
  return { kind, components, totalCents, band, inputs, validUntil, unconfirmed }
}

/** Provenance list for QuoteIssued v2. */
export function provenanceOf(components: PriceComponent[]) {
  return components.map((c) => ({
    component: c.component,
    dependency: c.dependency,
    source: c.source,
    version: c.version,
    as_of: c.asOf,
    age_seconds: c.ageSeconds,
    latency_ms: c.latencyMs,
    amount_cents_per_car: c.amountCentsPerCar,
  }))
}
