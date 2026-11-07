/**
 * Per-instance operating statistics for the ops page: dependency latency
 * samples, outcomes, cache hit rate, hedges, coalescing, breaker state, shed
 * and rate-limited counts, and quote latency by client class. Each instance
 * writes a snapshot to Valkey every second; the ops endpoint merges them.
 * Prometheus gets the same signals through the counters in shared/metrics.
 * @module api/services/ops-stats
 */
import type { Redis } from 'ioredis'
import { config } from '../../shared/config.js'
import { DEPENDENCIES, type Dependency } from '../../shared/domain.js'
import type { FailureKind } from '../../shared/dependency-client.js'
import type { FanoutObserver } from '../../shared/fanout.js'
import type { BreakerState } from '../../shared/breakers.js'
import type { ClientClass } from '../../shared/reference.js'
import { percentile } from '../../shared/resilience.js'
import { cacheLookups, coalescedTotal, dependencyDuration, hedgesTotal } from '../../shared/metrics.js'
import type { Settings } from '../../shared/settings.js'

class Ring {
  private readonly values: number[] = []
  constructor(private readonly size: number) {}
  push(v: number): void {
    this.values.push(v)
    if (this.values.length > this.size) this.values.shift()
  }
  all(): number[] {
    return [...this.values]
  }
  tail(n: number): number[] {
    return this.values.slice(-n)
  }
  clear(): void {
    this.values.length = 0
  }
}

export interface DepCounters {
  calls: number
  ok: number
  timeout: number
  error: number
  short_circuit: number
  rejected: number
  deadline: number
  cacheHit: number
  cacheMiss: number
  cacheStale: number
  hedgesFired: number
  hedgesWon: number
  hedgesSkipped: number
  coalesced: number
}

const CLASSES: ClientClass[] = ['portal', 'api', 'api_requote']
type QuoteOutcome = 'firm' | 'indicative' | 'unavailable' | 'shed' | 'rate_limited' | 'replayed'

const emptyDep = (): DepCounters => ({
  calls: 0, ok: 0, timeout: 0, error: 0, short_circuit: 0, rejected: 0, deadline: 0,
  cacheHit: 0, cacheMiss: 0, cacheStale: 0, hedgesFired: 0, hedgesWon: 0, hedgesSkipped: 0, coalesced: 0,
})

export interface InstanceSnapshot {
  instanceId: string
  at: string
  inflight: number
  deps: Record<Dependency, DepCounters & { samples: number[] }>
  breakers: Record<Dependency, BreakerState>
  quotes: Record<ClientClass, Record<QuoteOutcome, number> & { samples: number[] }>
}

export class OpsStats implements FanoutObserver {
  private deps = Object.fromEntries(DEPENDENCIES.map((d) => [d, emptyDep()])) as Record<Dependency, DepCounters>
  private readonly latency = Object.fromEntries(DEPENDENCIES.map((d) => [d, new Ring(1_000)])) as Record<Dependency, Ring>
  private quotes = Object.fromEntries(CLASSES.map((c) => [c, this.emptyQuotes()])) as Record<ClientClass, Record<QuoteOutcome, number>>
  private readonly quoteLatency = Object.fromEntries(CLASSES.map((c) => [c, new Ring(2_000)])) as Record<ClientClass, Ring>
  inflight = 0
  hedgePercentile = 90
  hedgeMinDelayMs = 60

  constructor(private readonly breakerStates: () => Record<Dependency, BreakerState>) {}

  private emptyQuotes(): Record<QuoteOutcome, number> {
    return { firm: 0, indicative: 0, unavailable: 0, shed: 0, rate_limited: 0, replayed: 0 }
  }

  applySettings(s: Settings): void {
    this.hedgePercentile = s.hedging.percentile
    this.hedgeMinDelayMs = s.hedging.minDelayMs
  }

  call(dep: Dependency, outcome: 'ok' | FailureKind, ms: number): void {
    const d = this.deps[dep]
    d.calls += 1
    d[outcome] += 1
    if (outcome === 'ok') this.latency[dep].push(ms)
    dependencyDuration.observe({ dependency: dep, outcome, caller: 'api' }, ms / 1000)
  }

  cache(dep: Dependency, result: 'hit' | 'miss' | 'stale_version'): void {
    const d = this.deps[dep]
    if (result === 'hit') d.cacheHit += 1
    else if (result === 'miss') d.cacheMiss += 1
    else d.cacheStale += 1
    cacheLookups.inc({ dependency: dep, result })
  }

  hedge(dep: Dependency, result: 'fired' | 'won' | 'skipped_budget'): void {
    const d = this.deps[dep]
    if (result === 'fired') d.hedgesFired += 1
    else if (result === 'won') d.hedgesWon += 1
    else d.hedgesSkipped += 1
    hedgesTotal.inc({ dependency: dep, result })
  }

  coalesced(dep: Dependency): void {
    this.deps[dep].coalesced += 1
    coalescedTotal.inc({ dependency: dep })
  }

  /** Hedge after the configured percentile of recent successful latency, never sooner than the floor. */
  hedgeDelayMs(dep: Dependency): number {
    const recent = this.latency[dep].tail(300)
    if (recent.length < 20) return Math.max(this.hedgeMinDelayMs, 150)
    return Math.max(this.hedgeMinDelayMs, percentile(recent, this.hedgePercentile) ?? this.hedgeMinDelayMs)
  }

  quote(cls: ClientClass, outcome: QuoteOutcome, ms: number): void {
    this.quotes[cls][outcome] += 1
    if (outcome !== 'shed' && outcome !== 'rate_limited') this.quoteLatency[cls].push(ms)
  }

  reset(): void {
    this.deps = Object.fromEntries(DEPENDENCIES.map((d) => [d, emptyDep()])) as Record<Dependency, DepCounters>
    for (const d of DEPENDENCIES) this.latency[d].clear()
    this.quotes = Object.fromEntries(CLASSES.map((c) => [c, this.emptyQuotes()])) as Record<ClientClass, Record<QuoteOutcome, number>>
    for (const c of CLASSES) this.quoteLatency[c].clear()
  }

  snapshot(): InstanceSnapshot {
    return {
      instanceId: config.instanceId,
      at: new Date().toISOString(),
      inflight: this.inflight,
      deps: Object.fromEntries(DEPENDENCIES.map((d) => [d, { ...this.deps[d], samples: this.latency[d].tail(400) }])) as InstanceSnapshot['deps'],
      breakers: this.breakerStates(),
      quotes: Object.fromEntries(CLASSES.map((c) => [c, { ...this.quotes[c], samples: this.quoteLatency[c].tail(1_000) }])) as InstanceSnapshot['quotes'],
    }
  }

  async publish(redis: Redis): Promise<void> {
    const key = `fq:ops:instance:${config.instanceId}`
    await redis.multi().set(key, JSON.stringify(this.snapshot()), 'EX', 10).sadd('fq:ops:instances', config.instanceId).exec()
  }
}

/** Merges every live instance's snapshot (counters summed, latency samples pooled). */
export async function loadSnapshots(redis: Redis): Promise<InstanceSnapshot[]> {
  const ids = await redis.smembers('fq:ops:instances')
  if (ids.length === 0) return []
  const raws = await redis.mget(ids.map((id) => `fq:ops:instance:${id}`))
  const out: InstanceSnapshot[] = []
  for (let i = 0; i < ids.length; i += 1) {
    if (raws[i]) out.push(JSON.parse(raws[i] as string) as InstanceSnapshot)
    else await redis.srem('fq:ops:instances', ids[i])
  }
  return out
}

const BREAKER_RANK: Record<BreakerState, number> = { closed: 0, halfOpen: 1, open: 2 }

export function mergeSnapshots(snapshots: InstanceSnapshot[]) {
  const dependencies = Object.fromEntries(
    DEPENDENCIES.map((dep) => {
      const counters = emptyDep()
      const samples: number[] = []
      const breakers: Record<string, BreakerState> = {}
      for (const s of snapshots) {
        const d = s.deps[dep]
        for (const k of Object.keys(counters) as (keyof DepCounters)[]) counters[k] += d[k] ?? 0
        samples.push(...d.samples)
        breakers[s.instanceId] = s.breakers[dep]
      }
      const worst = Object.values(breakers).reduce<BreakerState>((w, b) => (BREAKER_RANK[b] > BREAKER_RANK[w] ? b : w), 'closed')
      const lookups = counters.cacheHit + counters.cacheMiss + counters.cacheStale
      return [
        dep,
        {
          ...counters,
          p50: percentile(samples, 50),
          p95: percentile(samples, 95),
          p99: percentile(samples, 99),
          sampleCount: samples.length,
          cacheHitRate: lookups > 0 ? counters.cacheHit / lookups : null,
          breaker: worst,
          breakers,
        },
      ]
    }),
  )
  const quotes = Object.fromEntries(
    CLASSES.map((cls) => {
      const totals: Record<QuoteOutcome, number> = { firm: 0, indicative: 0, unavailable: 0, shed: 0, rate_limited: 0, replayed: 0 }
      const samples: number[] = []
      for (const s of snapshots) {
        const q = s.quotes[cls]
        for (const k of Object.keys(totals) as QuoteOutcome[]) totals[k] += q[k] ?? 0
        samples.push(...q.samples)
      }
      return [cls, { ...totals, p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99), sampleCount: samples.length }]
    }),
  )
  return {
    instances: snapshots.map((s) => ({ id: s.instanceId, at: s.at, inflight: s.inflight })),
    dependencies,
    quotes,
  }
}
