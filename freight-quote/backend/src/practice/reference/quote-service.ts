/**
 * Reference solution for the coding exercise. Don't read it before your attempt.
 *
 * Shape of the answer:
 *  - one promise per dependency, all started at once, each raced against
 *    min(its budget, time left) with an AbortController, so nothing waits on
 *    the slowest dependency past the deadline;
 *  - each branch resolves to a line (live, cache or missing) and never
 *    rejects, so Promise.all can't fail early or hang;
 *  - live answers are written to the cache, misses fall back to it, and
 *    pricing without any value is the one fatal case;
 *  - idempotency stores the in-flight promise under (customer, key), so
 *    concurrent duplicates share one execution, and forgets it on failure.
 * @module practice/reference/quote-service
 */
import {
  DEPENDENCY_NAMES,
  IdempotencyConflictError,
  PricingUnavailableError,
  type DependencyName,
  type Quote,
  type QuoteLine,
  type QuoteRequest,
  type QuoteServiceApi,
  type QuoteServiceDeps,
  type QuoteServiceOptions,
} from '../types.js'

export function componentCacheKey(dependency: DependencyName, r: QuoteRequest): string {
  const lane = `${r.origin}-${r.destination}`
  switch (dependency) {
    case 'pricing':
      // The contract id, never the customer id: customers on the public tariff share one entry,
      // and a contract price can only be read back by requests carrying that contract.
      return `pricing:${r.contractId ? `contract:${r.contractId}` : 'tariff'}:${lane}:${r.commodity}:${r.equipment}`
    case 'fuel':
      return `fuel:${lane}`
    case 'capacity':
      return `capacity:${lane}:${r.equipment}`
    case 'availability':
      return `availability:${r.origin}:${r.equipment}`
  }
}

function fingerprint(r: QuoteRequest): string {
  return JSON.stringify([r.customerId, r.contractId, r.origin, r.destination, r.commodity, r.equipment, r.quantity])
}

function withBudget<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`budget of ${ms} ms exceeded`))
    }, Math.max(0, ms))
    fn(controller.signal).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export class QuoteService implements QuoteServiceApi {
  private readonly submissions = new Map<string, { fingerprint: string; promise: Promise<Quote> }>()

  constructor(
    readonly deps: QuoteServiceDeps,
    readonly options: QuoteServiceOptions,
  ) {}

  submitQuote(request: QuoteRequest): Promise<Quote> {
    const key = `${request.customerId}\u0000${request.idempotencyKey}`
    const fp = fingerprint(request)
    const existing = this.submissions.get(key)
    if (existing) {
      if (existing.fingerprint !== fp) return Promise.reject(new IdempotencyConflictError())
      return existing.promise
    }
    const promise = this.execute(request)
    this.submissions.set(key, { fingerprint: fp, promise })
    // A failed attempt is not a result: forget it so a retry with the same key can succeed.
    promise.catch(() => {
      if (this.submissions.get(key)?.promise === promise) this.submissions.delete(key)
    })
    return promise
  }

  private async execute(request: QuoteRequest): Promise<Quote> {
    const deadlineAt = Date.now() + this.options.deadlineMs
    const lines = await Promise.all(DEPENDENCY_NAMES.map((dep) => this.line(dep, request, deadlineAt)))
    if (lines[0].source === 'missing') throw new PricingUnavailableError()
    const perCar = lines.reduce((sum, l) => sum + (l.amountCentsPerCar ?? 0), 0)
    return {
      id: this.deps.newId(),
      idempotencyKey: request.idempotencyKey,
      kind: lines.every((l) => l.source === 'live') ? 'firm' : 'indicative',
      totalCents: perCar * request.quantity,
      lines,
    }
  }

  private async line(dependency: DependencyName, request: QuoteRequest, deadlineAt: number): Promise<QuoteLine> {
    const key = componentCacheKey(dependency, request)
    const budget = Math.min(this.options.budgetsMs[dependency], deadlineAt - Date.now())
    try {
      const value = await withBudget((signal) => this.deps.dependencies[dependency](request, signal), budget)
      await this.deps.cache.set(key, value).catch(() => undefined)
      return { dependency, source: 'live', amountCentsPerCar: value.amountCentsPerCar, version: value.version, ageMs: 0 }
    } catch {
      const cached = await this.deps.cache.get(key).catch(() => undefined)
      if (cached) {
        return { dependency, source: 'cache', amountCentsPerCar: cached.amountCentsPerCar, version: cached.version, ageMs: this.deps.now() - cached.asOf }
      }
      return { dependency, source: 'missing', amountCentsPerCar: null, version: null, ageMs: null }
    }
  }
}
