/**
 * The practice suite for the coding exercise. `npm test` runs it against the
 * reference solution; `npm run practice` runs it against your attempt.
 * Real timers with generous margins: budgets are tens of milliseconds.
 */
import { describe, expect, it } from 'vitest'
import { componentCacheKey, PRACTICE_TARGET, QuoteService } from './subject.js'
import {
  IdempotencyConflictError,
  PricingUnavailableError,
  type ComponentCache,
  type ComponentValue,
  type DependencyCall,
  type DependencyName,
  type Quote,
  type QuoteLine,
  type QuoteRequest,
  type QuoteServiceOptions,
} from './types.js'

const SLACK = 60

class MemoryCache implements ComponentCache {
  readonly map = new Map<string, ComponentValue>()
  async get(key: string) {
    return this.map.get(key)
  }
  async set(key: string, value: ComponentValue) {
    this.map.set(key, value)
  }
}

interface Fake {
  call: DependencyCall
  calls: number
  aborted: number
}

/** Answers `value` after `ms`, unless aborted first. */
function answers(amount: number, ms = 5, version = 'v1'): Fake {
  const fake: Fake = {
    calls: 0,
    aborted: 0,
    call: (_req, signal) => {
      fake.calls += 1
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ amountCentsPerCar: amount, version, asOf: Date.now() }), ms)
        signal.addEventListener('abort', () => {
          clearTimeout(t)
          fake.aborted += 1
          reject(new Error('aborted'))
        })
      })
    },
  }
  return fake
}

/** Fails after `ms`. */
function fails(ms = 1): Fake {
  const fake: Fake = {
    calls: 0,
    aborted: 0,
    call: () => {
      fake.calls += 1
      return new Promise((_, reject) => setTimeout(() => reject(new Error('dependency error')), ms))
    },
  }
  return fake
}

/** Never answers; only an abort ends it. */
function hangs(): Fake {
  const fake: Fake = {
    calls: 0,
    aborted: 0,
    call: (_req, signal) => {
      fake.calls += 1
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          fake.aborted += 1
          reject(new Error('aborted'))
        })
      })
    },
  }
  return fake
}

const OPTIONS: QuoteServiceOptions = { deadlineMs: 150, budgetsMs: { pricing: 100, fuel: 100, capacity: 120, availability: 120 } }

function request(over: Partial<QuoteRequest> = {}): QuoteRequest {
  return { idempotencyKey: 'key-1', customerId: 'CUST-A', contractId: null, origin: 'KCK', destination: 'CHI', commodity: 'GRAIN', equipment: 'COVERED_HOPPER', quantity: 10, ...over }
}

function setup(fakes: Partial<Record<DependencyName, Fake>> = {}, options = OPTIONS, cache = new MemoryCache()) {
  const deps = {
    pricing: fakes.pricing ?? answers(100_000),
    fuel: fakes.fuel ?? answers(20_000),
    capacity: fakes.capacity ?? answers(5_000),
    availability: fakes.availability ?? answers(0),
  }
  let n = 0
  const service = new QuoteService(
    {
      dependencies: { pricing: deps.pricing.call, fuel: deps.fuel.call, capacity: deps.capacity.call, availability: deps.availability.call },
      cache,
      now: () => Date.now(),
      newId: () => `Q-${++n}`,
    },
    options,
  )
  return { service, deps, cache }
}

const line = (q: Quote, dep: DependencyName): QuoteLine => {
  const found = q.lines.find((l) => l.dependency === dep)
  if (!found) throw new Error(`no ${dep} line`)
  return found
}

describe(`quote service layer (${PRACTICE_TARGET})`, () => {
  describe('1. parallel fan-out under a deadline', () => {
    it('returns a firm quote when every dependency answers in time', async () => {
      const { service } = setup()
      const q = await service.submitQuote(request())
      expect(q.kind).toBe('firm')
      expect(q.id).toBe('Q-1')
      expect(q.totalCents).toBe((100_000 + 20_000 + 5_000 + 0) * 10)
      expect(q.lines.map((l) => l.dependency)).toEqual(['pricing', 'fuel', 'capacity', 'availability'])
      expect(q.lines.every((l) => l.source === 'live' && l.ageMs === 0)).toBe(true)
    })

    it('calls the dependencies in parallel, not one after another', async () => {
      const { service } = setup({ pricing: answers(1, 50), fuel: answers(1, 50), capacity: answers(1, 50), availability: answers(1, 50) })
      const t0 = Date.now()
      await service.submitQuote(request())
      expect(Date.now() - t0).toBeLessThan(120)
    })

    it('returns by the overall deadline even if a dependency never answers', async () => {
      const { service } = setup({ capacity: hangs() }, { deadlineMs: 80, budgetsMs: { pricing: 500, fuel: 500, capacity: 500, availability: 500 } })
      const t0 = Date.now()
      const q = await service.submitQuote(request())
      expect(Date.now() - t0).toBeLessThan(80 + SLACK)
      expect(q.kind).toBe('indicative')
      expect(line(q, 'capacity').source).toBe('missing')
    })

    it('enforces each dependency budget inside the overall deadline', async () => {
      const { service } = setup({ capacity: answers(5_000, 90) }, { deadlineMs: 400, budgetsMs: { pricing: 200, fuel: 200, capacity: 30, availability: 200 } })
      const t0 = Date.now()
      const q = await service.submitQuote(request())
      expect(Date.now() - t0).toBeLessThan(90)
      expect(line(q, 'capacity').source).toBe('missing')
    })

    it('aborts the signal of a dependency that ran out of budget', async () => {
      const capacity = hangs()
      const { service } = setup({ capacity })
      await service.submitQuote(request())
      expect(capacity.aborted).toBe(1)
    })

    it('treats a fast failure like a timeout without waiting for the deadline', async () => {
      const { service } = setup({ availability: fails(1) }, { deadlineMs: 1_000, budgetsMs: { pricing: 1_000, fuel: 1_000, capacity: 1_000, availability: 1_000 } })
      const t0 = Date.now()
      const q = await service.submitQuote(request())
      expect(Date.now() - t0).toBeLessThan(100)
      expect(line(q, 'availability').source).toBe('missing')
    })
  })

  describe('2. fallback to cached components', () => {
    it('writes live answers to the cache under componentCacheKey', async () => {
      const { service, cache } = setup()
      await service.submitQuote(request())
      for (const dep of ['pricing', 'fuel', 'capacity', 'availability'] as const) {
        expect(cache.map.has(componentCacheKey(dep, request()))).toBe(true)
      }
    })

    it('uses a cached component, with its age, when the dependency misses its budget', async () => {
      const cache = new MemoryCache()
      cache.map.set(componentCacheKey('capacity', request()), { amountCentsPerCar: 7_000, version: 'cap-snap-1', asOf: Date.now() - 120_000 })
      const { service } = setup({ capacity: hangs() }, OPTIONS, cache)
      const q = await service.submitQuote(request())
      const cap = line(q, 'capacity')
      expect(q.kind).toBe('indicative')
      expect(cap.source).toBe('cache')
      expect(cap.version).toBe('cap-snap-1')
      expect(cap.ageMs).toBeGreaterThanOrEqual(120_000)
      expect(cap.ageMs).toBeLessThan(125_000)
      expect(q.totalCents).toBe((100_000 + 20_000 + 7_000 + 0) * 10)
    })

    it('marks a component missing (null amount, excluded from the total) when there is no cache', async () => {
      const { service } = setup({ availability: fails() })
      const q = await service.submitQuote(request())
      const a = line(q, 'availability')
      expect(a.source).toBe('missing')
      expect(a.amountCentsPerCar).toBeNull()
      expect(q.totalCents).toBe((100_000 + 20_000 + 5_000) * 10)
    })

    it('refuses to quote without any linehaul price', async () => {
      const { service } = setup({ pricing: fails() })
      await expect(service.submitQuote(request())).rejects.toBeInstanceOf(PricingUnavailableError)
    })

    it('quotes indicatively from a cached tariff when pricing is down', async () => {
      const cache = new MemoryCache()
      cache.map.set(componentCacheKey('pricing', request()), { amountCentsPerCar: 99_000, version: 'tariff:v7', asOf: Date.now() - 5_000 })
      const { service } = setup({ pricing: hangs() }, OPTIONS, cache)
      const q = await service.submitQuote(request())
      expect(q.kind).toBe('indicative')
      expect(line(q, 'pricing').source).toBe('cache')
    })
  })

  describe('3. cache keys never leak a contract price', () => {
    it('keys contract prices by contract, and shares the tariff entry between tariff customers', () => {
      const contractA = request({ customerId: 'CUST-A', contractId: 'CTR-A' })
      const contractA2 = request({ customerId: 'CUST-A', contractId: 'CTR-A2' })
      const tariffB = request({ customerId: 'CUST-B', contractId: null })
      const tariffC = request({ customerId: 'CUST-C', contractId: null })
      expect(componentCacheKey('pricing', contractA)).not.toBe(componentCacheKey('pricing', tariffB))
      expect(componentCacheKey('pricing', contractA)).not.toBe(componentCacheKey('pricing', contractA2))
      expect(componentCacheKey('pricing', tariffB)).toBe(componentCacheKey('pricing', tariffC))
      expect(componentCacheKey('pricing', tariffB)).not.toBe(componentCacheKey('pricing', request({ destination: 'LAX' })))
      expect(componentCacheKey('pricing', tariffB)).not.toBe(componentCacheKey('pricing', request({ commodity: 'PLASTIC' })))
    })

    it('never serves one customer’s cached contract price to another', async () => {
      const cache = new MemoryCache()
      const first = setup({ pricing: answers(80_000, 5, 'contract:CTR-A:v3') }, OPTIONS, cache)
      await first.service.submitQuote(request({ customerId: 'CUST-A', contractId: 'CTR-A' }))
      const second = setup({ pricing: fails() }, OPTIONS, cache)
      await expect(second.service.submitQuote(request({ customerId: 'CUST-B', contractId: null, idempotencyKey: 'b-1' }))).rejects.toBeInstanceOf(PricingUnavailableError)
    })

    it('lets a tariff customer fall back to a tariff price cached by another tariff customer', async () => {
      const cache = new MemoryCache()
      const first = setup({ pricing: answers(95_000, 5, 'tariff:v7') }, OPTIONS, cache)
      await first.service.submitQuote(request({ customerId: 'CUST-C' }))
      const second = setup({ pricing: fails() }, OPTIONS, cache)
      const q = await second.service.submitQuote(request({ customerId: 'CUST-D', idempotencyKey: 'd-1' }))
      expect(line(q, 'pricing')).toMatchObject({ source: 'cache', amountCentsPerCar: 95_000, version: 'tariff:v7' })
    })
  })

  describe('4. idempotent submit', () => {
    it('returns the same quote for a retry with the same key, without calling dependencies again', async () => {
      const { service, deps } = setup()
      const a = await service.submitQuote(request())
      const b = await service.submitQuote(request())
      expect(b.id).toBe(a.id)
      expect(deps.pricing.calls).toBe(1)
    })

    it('runs concurrent duplicates once', async () => {
      const { service, deps } = setup({ pricing: answers(100_000, 30) })
      const [a, b, c] = await Promise.all([service.submitQuote(request()), service.submitQuote(request()), service.submitQuote(request())])
      expect(new Set([a.id, b.id, c.id]).size).toBe(1)
      expect(deps.pricing.calls).toBe(1)
    })

    it('rejects a different request under a key already used', async () => {
      const { service } = setup()
      await service.submitQuote(request())
      await expect(service.submitQuote(request({ quantity: 11 }))).rejects.toBeInstanceOf(IdempotencyConflictError)
    })

    it('scopes keys to the customer', async () => {
      const { service } = setup()
      const a = await service.submitQuote(request({ customerId: 'CUST-A' }))
      const b = await service.submitQuote(request({ customerId: 'CUST-B', destination: 'LAX' }))
      expect(b.id).not.toBe(a.id)
    })

    it('does not remember a failure: a retry with the same key can succeed', async () => {
      let pricingUp = false
      const pricing: Fake = {
        calls: 0,
        aborted: 0,
        call: () => {
          pricing.calls += 1
          return pricingUp ? Promise.resolve({ amountCentsPerCar: 100_000, version: 'tariff:v7', asOf: Date.now() }) : Promise.reject(new Error('down'))
        },
      }
      const { service } = setup({ pricing })
      await expect(service.submitQuote(request())).rejects.toBeInstanceOf(PricingUnavailableError)
      pricingUp = true
      const q = await service.submitQuote(request())
      expect(q.kind).toBe('firm')
      expect(pricing.calls).toBe(2)
    })
  })
})
