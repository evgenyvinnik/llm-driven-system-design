/**
 * HTTP client for the four dependencies. Every call carries an absolute
 * deadline: it aborts locally when the deadline passes, and (when deadline
 * propagation is on) sends X-Deadline so the dependency can stop working on a
 * request nobody is waiting for.
 * @module shared/dependency-client
 */
import { config } from './config.js'
import type { Dependency } from './domain.js'

export interface DependencyInput {
  customerId: string
  contractId: string | null
  origin: string
  destination: string
  commodity: string
  equipment: string
  quantity: number
  shipWeek: string
}

export interface PricingAnswer {
  basis: 'contract' | 'tariff'
  contractId: string | null
  contractVersion: number | null
  tariffId: string
  tariffVersion: number
  ratePerCarCents: number
  asOf: string
}
export interface FuelAnswer {
  effectiveDate: string
  centsPerMile: number
  miles: number
  amountPerCarCents: number
  asOf: string
}
export interface CapacityAnswer {
  snapshotId: string
  utilizationPct: number
  premiumPct: number
  transitDays: number
  asOf: string
}
export interface AvailabilityAnswer {
  snapshotId: string
  carsAvailable: number
  placementDays: number
  shortagePremiumCents: number
  asOf: string
}
export interface Answers {
  pricing: PricingAnswer
  fuel: FuelAnswer
  capacity: CapacityAnswer
  availability: AvailabilityAnswer
}

export type FailureKind = 'timeout' | 'error' | 'short_circuit' | 'rejected' | 'deadline'

export class DependencyError extends Error {
  constructor(
    readonly dependency: Dependency,
    readonly kind: FailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'DependencyError'
  }
}

const PATHS: Record<Dependency, string> = {
  pricing: '/pricing/rate',
  fuel: '/fuel/surcharge',
  capacity: '/capacity/check',
  availability: '/availability/check',
}

function bodyFor(dep: Dependency, input: DependencyInput): unknown {
  switch (dep) {
    case 'pricing':
      return { customerId: input.customerId, contractId: input.contractId, origin: input.origin, destination: input.destination, commodity: input.commodity, equipment: input.equipment }
    case 'fuel':
      return { origin: input.origin, destination: input.destination }
    case 'capacity':
    case 'availability':
      return { origin: input.origin, destination: input.destination, equipment: input.equipment, shipWeek: input.shipWeek, quantity: input.quantity }
  }
}

export interface CallOptions {
  deadlineAt: number
  signal?: AbortSignal
  propagateDeadline: boolean
  baseUrl?: string
}

export async function callDependency<D extends Dependency>(dep: D, input: DependencyInput, opts: CallOptions): Promise<Answers[D]> {
  const remaining = opts.deadlineAt - Date.now()
  if (remaining <= 0) throw new DependencyError(dep, 'deadline', `${dep}: no budget left`)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), remaining)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.propagateDeadline) headers['x-deadline'] = String(opts.deadlineAt)
    const res = await fetch(`${opts.baseUrl ?? config.depsUrl}${PATHS[dep]}`, { method: 'POST', headers, body: JSON.stringify(bodyFor(dep, input)), signal })
    if (res.status === 422) throw new DependencyError(dep, 'rejected', `${dep}: rejected input`, 422)
    if (res.status === 504) throw new DependencyError(dep, 'timeout', `${dep}: deadline exceeded upstream`, 504)
    if (!res.ok) throw new DependencyError(dep, 'error', `${dep}: HTTP ${res.status}`, res.status)
    return (await res.json()) as Answers[D]
  } catch (err) {
    if (err instanceof DependencyError) throw err
    if (timeout.signal.aborted) throw new DependencyError(dep, 'timeout', `${dep}: timed out after ${remaining} ms`)
    if (opts.signal?.aborted) throw new DependencyError(dep, 'timeout', `${dep}: cancelled (hedge lost or caller gave up)`)
    throw new DependencyError(dep, 'error', `${dep}: ${(err as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
}
