/**
 * Domain types for quotes and their price components, shared by the API,
 * the completer, the projector and (as JSON) the frontend.
 * @module shared/domain
 */
import type { ClientClass, Equipment } from './reference.js'

export type Dependency = 'pricing' | 'fuel' | 'capacity' | 'availability'
export const DEPENDENCIES: Dependency[] = ['pricing', 'fuel', 'capacity', 'availability']

export type ComponentName = 'linehaul' | 'fuel_surcharge' | 'capacity_premium' | 'equipment'
export const COMPONENT_OF: Record<Dependency, ComponentName> = {
  pricing: 'linehaul',
  fuel: 'fuel_surcharge',
  capacity: 'capacity_premium',
  availability: 'equipment',
}

/**
 * Where a component's value came from:
 *  - live: answered by the dependency inside this request's budget;
 *  - cache: a cached value (current for versioned inputs; last-known for perishable ones);
 *  - fallback: nothing usable, priced at zero premium and labeled unconfirmed.
 */
export type ComponentSource = 'live' | 'cache' | 'fallback'

/**
 * Versioned inputs (tariff, contract, weekly fuel surcharge) are valid until a
 * newer version is published, so a cached copy at the current version is as
 * good as a live answer. Perishable inputs (network capacity, car supply)
 * change continuously, so a cached copy is only an estimate.
 */
export const VERSIONED: Record<Dependency, boolean> = {
  pricing: true,
  fuel: true,
  capacity: false,
  availability: false,
}

export interface PriceComponent {
  component: ComponentName
  dependency: Dependency
  source: ComponentSource
  amountCentsPerCar: number
  /** What the price is based on, e.g. "tariff FQ-KCK-CHI-GRAIN v7" or "capacity snapshot cap-…". */
  basis: string
  /** Input version used, e.g. "tariff:v7", "contract:CTR-PGC-2026:v3", "fsc:2026-11-02", a snapshot id. */
  version: string | null
  /** When the dependency produced the value (event time of the input). */
  asOf: string
  /** Age of the value when the quote was issued. */
  ageSeconds: number
  /** Live call latency, null when served from cache or fallback. */
  latencyMs: number | null
  /** Human-readable staleness label; null when the value is live or a current version. */
  staleness: string | null
  detail: Record<string, unknown>
}

export type QuoteKind = 'firm' | 'indicative'
export type FirmStatus = 'not_needed' | 'pending' | 'completed' | 'delayed'
export type QuoteStatus = 'open' | 'booked' | 'expired'

/** Exactly what a firm quote was based on, so booking can honor it and a dispute can be reconstructed. */
export interface QuoteInputs {
  pricingBasis: 'contract' | 'tariff'
  tariffId: string | null
  tariffVersion: number | null
  contractId: string | null
  contractVersion: number | null
  fuelSurchargeDate: string | null
  fuelCentsPerMile: number | null
  capacitySnapshotId: string | null
  availabilitySnapshotId: string | null
  laneMiles: number
  rulesVersion: string
}

export interface QuoteRequestInput {
  origin: string
  destination: string
  commodity: string
  equipment: Equipment
  quantity: number
  shipWeek: string
}

export interface PriceBand {
  lowCents: number
  highCents: number
}

export interface QuoteView extends QuoteRequestInput {
  id: string
  customerId: string
  customerName?: string
  clientClass: ClientClass
  kind: QuoteKind
  firmStatus: FirmStatus
  status: QuoteStatus
  revision: number
  totalCents: number
  currency: string
  band: PriceBand
  components: PriceComponent[]
  inputs: QuoteInputs
  validUntil: string
  bookable: boolean
  createdAt: string
  firmAt: string | null
  latencyMs: number
  correlationId: string
  callback: boolean
  booking: { id: string; honoredTotalCents: number; createdAt: string } | null
}

/** Highest premium a capacity or equipment component can add, used for an indicative quote's price band. */
export const MAX_CAPACITY_PREMIUM_PCT = 15
export const MAX_EQUIPMENT_PREMIUM_CENTS = 25_000
