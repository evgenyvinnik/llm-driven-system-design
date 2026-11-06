/**
 * Reference data shared by the quote service, the mock dependencies and the
 * seed: stations, lanes, commodities, equipment types, customers and their
 * contracts. Every name, code, mileage and rate here is an illustrative
 * assumption for practice, not a real tariff or customer.
 * @module shared/reference
 */

export interface Station {
  code: string
  name: string
}

export const STATIONS: Station[] = [
  { code: 'KCK', name: 'Kansas City, KS' },
  { code: 'CHI', name: 'Chicago, IL' },
  { code: 'FTW', name: 'Fort Worth, TX' },
  { code: 'HOU', name: 'Houston, TX' },
  { code: 'DEN', name: 'Denver, CO' },
  { code: 'BAR', name: 'Barstow, CA' },
  { code: 'LAX', name: 'Los Angeles, CA' },
  { code: 'PDX', name: 'Portland, OR' },
  { code: 'MSP', name: 'Minneapolis, MN' },
]

export interface Lane {
  origin: string
  destination: string
  /** Illustrative rail miles. */
  miles: number
}

export const LANES: Lane[] = [
  { origin: 'KCK', destination: 'CHI', miles: 450 },
  { origin: 'FTW', destination: 'CHI', miles: 960 },
  { origin: 'HOU', destination: 'CHI', miles: 1_090 },
  { origin: 'MSP', destination: 'PDX', miles: 1_780 },
  { origin: 'DEN', destination: 'FTW', miles: 790 },
  { origin: 'KCK', destination: 'LAX', miles: 1_640 },
  { origin: 'BAR', destination: 'KCK', miles: 1_450 },
  { origin: 'HOU', destination: 'LAX', miles: 1_590 },
  { origin: 'MSP', destination: 'HOU', miles: 1_270 },
  { origin: 'PDX', destination: 'LAX', miles: 1_010 },
]

export type Equipment = 'COVERED_HOPPER' | 'BOXCAR' | 'CENTERBEAM' | 'TANK' | 'GONDOLA'
export const EQUIPMENT: { code: Equipment; name: string; factor: number }[] = [
  { code: 'COVERED_HOPPER', name: 'Covered hopper', factor: 1.0 },
  { code: 'BOXCAR', name: 'Boxcar', factor: 1.08 },
  { code: 'CENTERBEAM', name: 'Centerbeam flat', factor: 1.12 },
  { code: 'TANK', name: 'Tank car', factor: 1.2 },
  { code: 'GONDOLA', name: 'Gondola', factor: 0.95 },
]

export interface Commodity {
  code: string
  /** STCC-style code, illustrative. */
  stcc: string
  name: string
  /** Illustrative linehaul cents per car-mile before the equipment factor. */
  centsPerMile: number
  equipment: Equipment[]
}

export const COMMODITIES: Commodity[] = [
  { code: 'GRAIN', stcc: '01137', name: 'Wheat', centsPerMile: 290, equipment: ['COVERED_HOPPER'] },
  { code: 'PLASTIC', stcc: '28211', name: 'Plastic pellets', centsPerMile: 330, equipment: ['COVERED_HOPPER'] },
  { code: 'LUMBER', stcc: '24211', name: 'Lumber', centsPerMile: 310, equipment: ['CENTERBEAM', 'BOXCAR'] },
  { code: 'PAPER', stcc: '26211', name: 'Paper rolls', centsPerMile: 300, equipment: ['BOXCAR'] },
  { code: 'CHEM', stcc: '28199', name: 'Industrial chemicals', centsPerMile: 380, equipment: ['TANK'] },
  { code: 'STEEL', stcc: '33122', name: 'Steel coils', centsPerMile: 320, equipment: ['GONDOLA', 'BOXCAR'] },
]

export interface Contract {
  id: string
  customerId: string
  version: number
  origin: string
  destination: string
  commodity: string
  equipment: Equipment
  ratePerCarCents: number
}

/** Customer-specific contract rates. Never shared with another customer, in the cache or anywhere else. */
export const CONTRACTS: Contract[] = [
  { id: 'CTR-PGC-2026', customerId: 'CUST-PGC', version: 3, origin: 'KCK', destination: 'CHI', commodity: 'GRAIN', equipment: 'COVERED_HOPPER', ratePerCarCents: 118_000 },
  { id: 'CTR-PGC-2026', customerId: 'CUST-PGC', version: 3, origin: 'MSP', destination: 'PDX', commodity: 'GRAIN', equipment: 'COVERED_HOPPER', ratePerCarCents: 452_000 },
  { id: 'CTR-GPX-2026', customerId: 'CUST-GPX', version: 1, origin: 'HOU', destination: 'CHI', commodity: 'PLASTIC', equipment: 'COVERED_HOPPER', ratePerCarCents: 309_000 },
]

export type ClientClass = 'portal' | 'api' | 'api_requote'

export interface CustomerRef {
  id: string
  name: string
  /** Development-only API key for integrations (stored hashed in the database). */
  apiKey: string | null
  webhook: boolean
  ratePerMinute: number | null
}

export const CUSTOMERS: CustomerRef[] = [
  { id: 'CUST-PGC', name: 'Prairie Grain Co-op', apiKey: null, webhook: true, ratePerMinute: null },
  { id: 'CUST-NLL', name: 'Northline Lumber', apiKey: null, webhook: false, ratePerMinute: null },
  { id: 'CUST-GPX', name: 'Gulf Plastics Exchange', apiKey: 'fq_dev_gpx_7d1c4e', webhook: true, ratePerMinute: 240 },
  { id: 'CUST-SFL', name: 'Summit Freight Logistics', apiKey: 'fq_dev_sfl_93ab20', webhook: false, ratePerMinute: 120 },
]

export function laneOf(origin: string, destination: string): Lane | undefined {
  return LANES.find((l) => l.origin === origin && l.destination === destination)
}

export function commodityOf(code: string): Commodity | undefined {
  return COMMODITIES.find((c) => c.code === code)
}

export function equipmentFactor(code: Equipment): number {
  return EQUIPMENT.find((e) => e.code === code)?.factor ?? 1
}

export function contractFor(customerId: string, origin: string, destination: string, commodity: string, equipment: string): Contract | undefined {
  return CONTRACTS.find(
    (c) => c.customerId === customerId && c.origin === origin && c.destination === destination && c.commodity === commodity && c.equipment === equipment,
  )
}

export const laneKey = (origin: string, destination: string) => `${origin}-${destination}`

/** Monday (UTC) of the week containing `date`, as YYYY-MM-DD. Fuel surcharges are published weekly. */
export function weekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (day - 1))
  return d.toISOString().slice(0, 10)
}

const EQUIPMENT_ABBREV: Record<Equipment, string> = { COVERED_HOPPER: 'CH', BOXCAR: 'BX', CENTERBEAM: 'CB', TANK: 'TK', GONDOLA: 'GD' }

/** Public tariff item id for a lane, commodity and equipment type. */
export const tariffIdOf = (origin: string, destination: string, commodity: string, equipment: string) =>
  `TRF-${origin}${destination}-${commodity}-${EQUIPMENT_ABBREV[equipment as Equipment] ?? equipment}`

/** Tariff versions in effect when the seed runs. */
export const INITIAL_TARIFF_VERSION = 7

/** Illustrative public tariff rate per car at a given version (3% per published version). */
export function tariffRateCents(origin: string, destination: string, commodity: string, equipment: string, version: number): number | null {
  const lane = laneOf(origin, destination)
  const c = commodityOf(commodity)
  if (!lane || !c) return null
  const base = lane.miles * c.centsPerMile * equipmentFactor(equipment as Equipment)
  return Math.round((base * 1.03 ** (version - INITIAL_TARIFF_VERSION)) / 100) * 100
}

/** Fuel surcharge in effect when the seed runs (illustrative cents per car-mile). */
export const INITIAL_FUEL_CENTS_PER_MILE = 42
