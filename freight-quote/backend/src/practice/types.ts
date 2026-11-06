/**
 * Types for the 45-minute coding exercise (see ../../../coding-exercise.md).
 * The exercise is a distilled version of the real quote path in
 * src/shared/fanout.ts and src/shared/compose.ts: no HTTP, no Valkey, no
 * breakers. Just the service-layer logic an interviewer asks you to write.
 * @module practice/types
 */

export type DependencyName = 'pricing' | 'fuel' | 'capacity' | 'availability'
export const DEPENDENCY_NAMES: DependencyName[] = ['pricing', 'fuel', 'capacity', 'availability']

export interface QuoteRequest {
  /** Chosen by the client and reused on every retry of the same request. Scoped to the customer. */
  idempotencyKey: string
  customerId: string
  /** Resolved by the server from the authenticated customer; null means public tariff pricing. */
  contractId: string | null
  origin: string
  destination: string
  commodity: string
  equipment: string
  quantity: number
}

export interface ComponentValue {
  amountCentsPerCar: number
  /** e.g. "tariff:v7", "contract:CTR-1:v3", "fsc:2026-11-02", a snapshot id. */
  version: string
  /** When the dependency produced the value, epoch ms. */
  asOf: number
}

/** One dependency. It should stop work when `signal` aborts (the fakes in the tests do). */
export type DependencyCall = (request: QuoteRequest, signal: AbortSignal) => Promise<ComponentValue>

export interface ComponentCache {
  get(key: string): Promise<ComponentValue | undefined>
  set(key: string, value: ComponentValue): Promise<void>
}

export interface QuoteServiceDeps {
  dependencies: Record<DependencyName, DependencyCall>
  cache: ComponentCache
  /** Clock for ages. */
  now: () => number
  newId: () => string
}

export interface QuoteServiceOptions {
  /** Overall deadline for submitQuote, from the moment it is called. */
  deadlineMs: number
  /** Per-dependency budget; the effective budget is min(budget, time left before the deadline). */
  budgetsMs: Record<DependencyName, number>
}

export type LineSource = 'live' | 'cache' | 'missing'

export interface QuoteLine {
  dependency: DependencyName
  source: LineSource
  /** null when missing. */
  amountCentsPerCar: number | null
  version: string | null
  /** 0 for live, now() - asOf for cache, null for missing. */
  ageMs: number | null
}

export interface Quote {
  id: string
  idempotencyKey: string
  kind: 'firm' | 'indicative'
  /** Sum of the non-missing lines' amounts, times quantity. */
  totalCents: number
  /** One line per dependency, in DEPENDENCY_NAMES order. */
  lines: QuoteLine[]
}

export class PricingUnavailableError extends Error {
  constructor(message = 'pricing unavailable and no cached price') {
    super(message)
    this.name = 'PricingUnavailableError'
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'idempotency key reused for a different request') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

export interface QuoteServiceApi {
  submitQuote(request: QuoteRequest): Promise<Quote>
}

/** What a practice attempt (and the reference solution) must export. */
export interface PracticeModule {
  QuoteService: new (deps: QuoteServiceDeps, options: QuoteServiceOptions) => QuoteServiceApi
  componentCacheKey(dependency: DependencyName, request: QuoteRequest): string
}
