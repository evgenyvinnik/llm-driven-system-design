/**
 * The parallel fan-out to the four dependencies under one deadline.
 *
 * For each dependency:
 *  - budget = min(its own budget, time left before the overall deadline);
 *  - versioned components (linehaul, fuel) are looked up in the cache first
 *    and served from it when the cached version is current;
 *  - identical in-flight calls are coalesced (single-flight), outside the
 *    breaker, so fifty identical requests count as one call and one outcome;
 *  - the breaker wraps the (possibly hedged) call;
 *  - live answers are written back to the cache; a failed perishable call
 *    falls back to the last-known snapshot for an indicative quote.
 *
 * Every branch resolves; nothing here throws. The composer decides what the
 * results add up to.
 * @module shared/fanout
 */
import type { Dependency } from './domain.js'
import { DEPENDENCIES, VERSIONED } from './domain.js'
import { callDependency, DependencyError, type Answers, type DependencyInput, type FailureKind } from './dependency-client.js'
import type { ComponentCache } from './component-cache.js'
import type { DependencyBreakers } from './breakers.js'
import { hedged, type HedgeBudget, type SingleFlight } from './resilience.js'
import { coalesceKey } from './cache-keys.js'
import type { ComponentResult, ComponentResults } from './compose.js'

export interface FanoutObserver {
  call(dep: Dependency, outcome: 'ok' | FailureKind, ms: number): void
  cache(dep: Dependency, result: 'hit' | 'miss' | 'stale_version'): void
  hedge(dep: Dependency, result: 'fired' | 'won' | 'skipped_budget'): void
  coalesced(dep: Dependency): void
  /** Current hedge delay for a dependency (a high percentile of its recent latency). */
  hedgeDelayMs(dep: Dependency): number
}

export const noopObserver: FanoutObserver = {
  call: () => undefined,
  cache: () => undefined,
  hedge: () => undefined,
  coalesced: () => undefined,
  hedgeDelayMs: () => 100,
}

export interface FanoutOptions {
  deadlineAt: number
  budgets: Record<Dependency, number>
  propagateDeadline: boolean
  hedgeDeps: Dependency[]
  coalescing: boolean
  /** When false (the async completer), versioned components are not served from cache. */
  cacheFirst: boolean
}

export interface FanoutContext {
  cache: ComponentCache
  breakers: DependencyBreakers
  singleFlight: SingleFlight
  hedgeBudgets: Record<Dependency, HedgeBudget>
  observer: FanoutObserver
  depsUrl?: string
}

export async function fetchComponents(input: DependencyInput, opts: FanoutOptions, ctx: FanoutContext): Promise<ComponentResults> {
  const entries = await Promise.all(DEPENDENCIES.map(async (dep) => [dep, await fetchOne(dep, input, opts, ctx)] as const))
  return Object.fromEntries(entries) as unknown as ComponentResults
}

async function fetchOne<D extends Dependency>(dep: D, input: DependencyInput, opts: FanoutOptions, ctx: FanoutContext): Promise<ComponentResult<D>> {
  const { observer } = ctx

  if (VERSIONED[dep] && opts.cacheFirst) {
    const hit = await ctx.cache.get(dep, input).catch(() => null)
    if (hit?.current) {
      observer.cache(dep, 'hit')
      return { status: 'cached', value: hit.value, cachedAt: hit.cachedAt }
    }
    observer.cache(dep, hit ? 'stale_version' : 'miss')
  }

  const started = Date.now()
  const deadlineAt = Math.min(opts.deadlineAt, started + opts.budgets[dep])
  try {
    const { value, shared, wasHedged } = await coalescedCall(dep, input, deadlineAt, opts, ctx)
    const latencyMs = Date.now() - started
    if (!shared) void ctx.cache.set(dep, input, value).catch(() => undefined)
    return { status: 'live', value, latencyMs, shared, hedged: wasHedged }
  } catch (err) {
    const reason: FailureKind = err instanceof DependencyError ? err.kind : 'error'
    const latencyMs = Date.now() - started
    const cached = await ctx.cache.get(dep, input).catch(() => null)
    // A superseded tariff or contract version is never served. Fuel and the perishable inputs may
    // fall back to a cached value, which the composer labels with its age.
    const fallback = cached && (dep !== 'pricing' || cached.current) ? cached : null
    if (dep === 'pricing' && fallback) return { status: 'cached', value: fallback.value, cachedAt: fallback.cachedAt }
    return { status: 'failed', reason, latencyMs, fallback }
  }
}

async function coalescedCall<D extends Dependency>(
  dep: D,
  input: DependencyInput,
  deadlineAt: number,
  opts: FanoutOptions,
  ctx: FanoutContext,
): Promise<{ value: Answers[D]; shared: boolean; wasHedged: boolean }> {
  let wasHedged = false
  const run = async (): Promise<Answers[D]> => {
    const started = Date.now()
    try {
      const value = await ctx.breakers.fire(dep, () => hedgedCall(dep, input, deadlineAt, opts, ctx, () => (wasHedged = true)))
      ctx.observer.call(dep, 'ok', Date.now() - started)
      return value
    } catch (err) {
      ctx.observer.call(dep, err instanceof DependencyError ? err.kind : 'error', Date.now() - started)
      throw err
    }
  }
  if (!opts.coalescing) return { value: await run(), shared: false, wasHedged }

  const flight = ctx.singleFlight.do(coalesceKey(dep, input), run)
  if (flight.shared) ctx.observer.coalesced(dep)
  // A follower never waits past its own deadline, even if the leader's call runs longer.
  const value = await raceDeadline(flight.promise, deadlineAt, dep)
  return { value, shared: flight.shared, wasHedged }
}

function hedgedCall<D extends Dependency>(dep: D, input: DependencyInput, deadlineAt: number, opts: FanoutOptions, ctx: FanoutContext, markHedged: () => void): Promise<Answers[D]> {
  const attempt = (signal?: AbortSignal) => callDependency(dep, input, { deadlineAt, signal, propagateDeadline: opts.propagateDeadline, baseUrl: ctx.depsUrl })
  if (!opts.hedgeDeps.includes(dep)) return attempt()
  const budget = ctx.hedgeBudgets[dep]
  budget.onCall()
  return hedged((signal) => attempt(signal), {
    delayMs: ctx.observer.hedgeDelayMs(dep),
    canHedge: () => {
      // Never hedge a recovering dependency, and never past the hedge budget.
      if (ctx.breakers.state(dep) !== 'closed') return false
      if (deadlineAt - Date.now() < 20) return false
      if (!budget.tryTake()) {
        ctx.observer.hedge(dep, 'skipped_budget')
        return false
      }
      return true
    },
    onHedge: () => {
      markHedged()
      ctx.observer.hedge(dep, 'fired')
    },
    onHedgeWin: () => ctx.observer.hedge(dep, 'won'),
  })
}

function raceDeadline<T>(promise: Promise<T>, deadlineAt: number, dep: Dependency): Promise<T> {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return Promise.reject(new DependencyError(dep, 'deadline', `${dep}: no budget left`))
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DependencyError(dep, 'timeout', `${dep}: shared call outlived this request's budget`)), remaining)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
