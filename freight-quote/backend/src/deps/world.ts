/**
 * The mock dependencies' answers: tariff and contract rates (pricing), the
 * weekly fuel surcharge (fuel), lane utilization (capacity) and car supply at
 * the origin (availability). Deterministic for a given input and time bucket,
 * so cached and live answers can be compared. All numbers are illustrative.
 * @module deps/world
 */
import { createHash } from 'node:crypto'
import {
  CONTRACTS,
  INITIAL_FUEL_CENTS_PER_MILE,
  INITIAL_TARIFF_VERSION,
  laneOf,
  tariffIdOf,
  tariffRateCents,
  weekStart,
} from '../shared/reference.js'

function unit(seed: string): number {
  return createHash('sha1').update(seed).digest().readUInt32BE(0) / 0xffffffff
}

export interface WorldState {
  tariffs: [string, { version: number; publishedAt: string }][]
  fuel: PricingWorld['fuel']
}

export class PricingWorld {
  /** tariffId → current version and when it was published. */
  readonly tariffs = new Map<string, { version: number; publishedAt: string }>()
  fuel = { effectiveDate: weekStart(new Date()), centsPerMile: INITIAL_FUEL_CENTS_PER_MILE, publishedAt: new Date().toISOString() }

  /** The mock pricing system's own state, persisted so a restart doesn't roll published tariffs back. */
  toState(): WorldState {
    return { tariffs: [...this.tariffs.entries()], fuel: this.fuel }
  }

  load(state: WorldState): void {
    this.tariffs.clear()
    for (const [id, t] of state.tariffs) this.tariffs.set(id, t)
    this.fuel = state.fuel
  }

  tariffVersion(tariffId: string): { version: number; publishedAt: string } {
    return this.tariffs.get(tariffId) ?? { version: INITIAL_TARIFF_VERSION, publishedAt: new Date(Date.now() - 14 * 86_400_000).toISOString() }
  }

  rate(input: { customerId: string; contractId: string | null; origin: string; destination: string; commodity: string; equipment: string }) {
    const contract = input.contractId
      ? CONTRACTS.find(
          (c) => c.id === input.contractId && c.customerId === input.customerId && c.origin === input.origin && c.destination === input.destination && c.commodity === input.commodity && c.equipment === input.equipment,
        )
      : undefined
    if (input.contractId && !contract) return null
    const tariffId = tariffIdOf(input.origin, input.destination, input.commodity, input.equipment)
    const t = this.tariffVersion(tariffId)
    const tariffRate = tariffRateCents(input.origin, input.destination, input.commodity, input.equipment, t.version)
    if (tariffRate === null) return null
    if (contract) {
      return {
        basis: 'contract' as const,
        contractId: contract.id,
        contractVersion: contract.version,
        tariffId,
        tariffVersion: t.version,
        ratePerCarCents: contract.ratePerCarCents,
        asOf: '2026-01-01T00:00:00.000Z',
      }
    }
    return { basis: 'tariff' as const, contractId: null, contractVersion: null, tariffId, tariffVersion: t.version, ratePerCarCents: tariffRate, asOf: t.publishedAt }
  }

  publishTariff(origin: string, destination: string, commodity: string, equipment: string, explicitVersion?: number) {
    const tariffId = tariffIdOf(origin, destination, commodity, equipment)
    const current = this.tariffVersion(tariffId)
    const version = explicitVersion ?? current.version + 1
    const rate = tariffRateCents(origin, destination, commodity, equipment, version)
    if (rate === null) return null
    const publishedAt = new Date().toISOString()
    if (version > current.version) this.tariffs.set(tariffId, { version, publishedAt })
    return { tariffId, version, rate, publishedAt }
  }

  surcharge(origin: string, destination: string) {
    const lane = laneOf(origin, destination)
    if (!lane) return null
    return {
      effectiveDate: this.fuel.effectiveDate,
      centsPerMile: this.fuel.centsPerMile,
      miles: lane.miles,
      amountPerCarCents: Math.round(lane.miles * this.fuel.centsPerMile),
      asOf: this.fuel.publishedAt,
    }
  }

  /** Utilization moves every 5 minutes; above 80% a capacity premium of up to 15% applies. */
  capacity(origin: string, destination: string, equipment: string, shipWeek: string, now = Date.now()) {
    const lane = laneOf(origin, destination)
    if (!lane) return null
    const bucket = Math.floor(now / 300_000)
    const utilization = Math.round(55 + unit(`${origin}${destination}${equipment}${shipWeek}${bucket}`) * 43)
    const premiumPct = utilization > 80 ? Math.round(((utilization - 80) / 20) * 15 * 10) / 10 : 0
    return {
      snapshotId: `cap-${origin}${destination}-${shipWeek}-${bucket}`,
      utilizationPct: utilization,
      premiumPct,
      transitDays: Math.ceil(lane.miles / 360) + 1,
      asOf: new Date(bucket * 300_000).toISOString(),
    }
  }

  /** Cars of the type available near the origin; a shortfall adds a per-car repositioning premium. */
  availability(origin: string, equipment: string, shipWeek: string, quantity: number, now = Date.now()) {
    const bucket = Math.floor(now / 300_000)
    const carsAvailable = Math.round(unit(`${origin}${equipment}${shipWeek}${bucket}`) * 140)
    const short = carsAvailable < quantity
    return {
      snapshotId: `avl-${origin}-${equipment}-${shipWeek}-${bucket}`,
      carsAvailable,
      placementDays: short ? 6 : 2,
      shortagePremiumCents: short ? 18_000 : 0,
      asOf: new Date(bucket * 300_000).toISOString(),
    }
  }
}
