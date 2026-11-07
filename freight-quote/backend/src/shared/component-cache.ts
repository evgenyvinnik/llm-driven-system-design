/**
 * The component cache in Valkey.
 *
 * Versioned components (linehaul, fuel surcharge) are served from cache only
 * when their version is at or above the floor that TariffPublished /
 * FuelSurchargeChanged raised. A cached value at the current version is
 * exactly as correct as a live answer, so a firm quote may use it.
 * Perishable components (capacity, car supply) are cached as last-known
 * snapshots and used only, labeled with their age, in indicative quotes.
 * @module shared/component-cache
 */
import type { Redis } from 'ioredis'
import type { Dependency } from './domain.js'
import type { Answers, DependencyInput } from './dependency-client.js'
import { componentCacheKey, fuelFloorKey, tariffFloorKey } from './cache-keys.js'

const TTL_SECONDS: Record<Dependency, number> = {
  pricing: 24 * 3600,
  fuel: 7 * 24 * 3600,
  capacity: 3600,
  availability: 3600,
}

const NO_FLOOR = 'fq:floor:none'

/** Versions as strings that sort correctly: zero-padded tariff/contract versions, ISO dates, ISO timestamps. */
export function sortableVersion<D extends Dependency>(dep: D, value: Answers[D]): string {
  switch (dep) {
    case 'pricing': {
      const v = value as Answers['pricing']
      return `v${String(v.basis === 'contract' ? v.contractVersion ?? 0 : v.tariffVersion).padStart(6, '0')}`
    }
    case 'fuel': {
      // Effective week, then publication time, so a same-week correction supersedes the original.
      const f = value as Answers['fuel']
      return `${f.effectiveDate}|${f.asOf}`
    }
    default:
      return (value as Answers['capacity']).asOf
  }
}

export const tariffFloorValue = (version: number) => `v${String(version).padStart(6, '0')}`

function floorKeyFor(dep: Dependency, input: DependencyInput): string {
  if (dep === 'pricing' && !input.contractId) return tariffFloorKey(input.origin, input.destination, input.commodity, input.equipment)
  if (dep === 'fuel') return fuelFloorKey()
  return NO_FLOOR
}

export interface CacheHit<D extends Dependency> {
  value: Answers[D]
  cachedAt: string
  /** False when a newer version has been published since this value was cached. */
  current: boolean
}

const SET_IF_NOT_BELOW_FLOOR = `
local floor = redis.call('GET', KEYS[2])
if floor and ARGV[2] < floor then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`

const RAISE_FLOOR = `
local floor = redis.call('GET', KEYS[1])
if floor and ARGV[1] <= floor then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
if KEYS[2] then redis.call('DEL', KEYS[2]) end
return 1
`

export class ComponentCache {
  constructor(private readonly redis: Redis) {}

  async get<D extends Dependency>(dep: D, input: DependencyInput): Promise<CacheHit<D> | null> {
    const [raw, floor] = await this.redis.mget(componentCacheKey(dep, input), floorKeyFor(dep, input))
    if (!raw) return null
    const entry = JSON.parse(raw) as { value: Answers[D]; cachedAt: string }
    const current = !floor || sortableVersion(dep, entry.value) >= floor
    return { value: entry.value, cachedAt: entry.cachedAt, current }
  }

  /** Writes unless a newer version was published while the call was in flight. Returns whether it wrote. */
  async set<D extends Dependency>(dep: D, input: DependencyInput, value: Answers[D]): Promise<boolean> {
    const payload = JSON.stringify({ value, cachedAt: new Date().toISOString() })
    const wrote = await this.redis.eval(SET_IF_NOT_BELOW_FLOOR, 2, componentCacheKey(dep, input), floorKeyFor(dep, input), payload, sortableVersion(dep, value), TTL_SECONDS[dep])
    return wrote === 1
  }

  /** TariffPublished: raise the lane's floor to the new version and drop the public tariff entry. Monotonic. */
  async raiseTariffFloor(origin: string, destination: string, commodity: string, equipment: string, version: number): Promise<boolean> {
    const key = componentCacheKey('pricing', { contractId: null, origin, destination, commodity, equipment, shipWeek: '' })
    const raised = await this.redis.eval(RAISE_FLOOR, 2, tariffFloorKey(origin, destination, commodity, equipment), key, tariffFloorValue(version))
    return raised === 1
  }

  /** FuelSurchargeChanged: entries from older publications stop being current. Monotonic. */
  async raiseFuelFloor(effectiveDate: string, publishedAt: string): Promise<boolean> {
    const raised = await this.redis.eval(RAISE_FLOOR, 1, fuelFloorKey(), `${effectiveDate}|${publishedAt}`)
    return raised === 1
  }
}
