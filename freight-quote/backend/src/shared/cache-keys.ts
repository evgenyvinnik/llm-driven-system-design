/**
 * Component cache keys. The rule that matters: a linehaul price is cached
 * under its pricing basis. Contract prices are keyed by contract id, which the
 * server resolves from the authenticated customer, never from the request
 * body. Customers without a contract share the public tariff entry for the
 * lane, commodity and equipment. Two customers can therefore share a cache
 * entry only when they would be charged the same published price.
 * @module shared/cache-keys
 */
import type { Dependency } from './domain.js'

export interface CacheKeyInput {
  contractId: string | null
  origin: string
  destination: string
  commodity: string
  equipment: string
  shipWeek: string
}

export function componentCacheKey(dep: Dependency, q: CacheKeyInput): string {
  const lane = `${q.origin}-${q.destination}`
  switch (dep) {
    case 'pricing':
      return q.contractId
        ? `fq:cache:linehaul:contract:${q.contractId}:${lane}:${q.commodity}:${q.equipment}`
        : `fq:cache:linehaul:tariff:${lane}:${q.commodity}:${q.equipment}`
    case 'fuel':
      return `fq:cache:fuel:${lane}:${q.commodity}`
    case 'capacity':
      // Last-known snapshot, only ever used (labeled) for indicative quotes.
      return `fq:cache:capacity:${lane}:${q.equipment}:${q.shipWeek}`
    case 'availability':
      return `fq:cache:availability:${q.origin}:${q.equipment}:${q.shipWeek}`
  }
}

/**
 * Version floors: the oldest version a cached value may carry and still be
 * served. TariffPublished raises the tariff floor for its lane; a fuel
 * surcharge change raises the fuel floor. A slow in-flight pricing call that
 * returns an old version after the event can then neither be served nor
 * written back over the invalidation.
 */
export const tariffFloorKey = (origin: string, destination: string, commodity: string, equipment: string) =>
  `fq:floor:tariff:${origin}-${destination}:${commodity}:${equipment}`
export const fuelFloorKey = () => 'fq:floor:fuel'

/** Single-flight key for one dependency call: identical inputs share one in-flight call. */
export function coalesceKey(dep: Dependency, q: CacheKeyInput & { quantity: number }): string {
  switch (dep) {
    case 'pricing':
      return `pricing:${q.contractId ?? 'tariff'}:${q.origin}-${q.destination}:${q.commodity}:${q.equipment}`
    case 'fuel':
      return `fuel:${q.origin}-${q.destination}:${q.commodity}`
    case 'capacity':
      return `capacity:${q.origin}-${q.destination}:${q.equipment}:${q.shipWeek}:${q.quantity}`
    case 'availability':
      return `availability:${q.origin}:${q.equipment}:${q.shipWeek}:${q.quantity}`
  }
}
