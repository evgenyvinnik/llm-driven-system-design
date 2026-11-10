/**
 * Chaos switches shared by the mock model and the mock judge.
 *
 * Armed counts make failures deterministic for demos and the e2e suite:
 * `{ rate_limit: 3 }` fails exactly the next three calls with 429. Rates add
 * background noise for load tests. Armed counts are consumed first, in the
 * fixed order of CHAOS_KINDS.
 * @module shared/chaos
 */

export const CHAOS_KINDS = ['rate_limit', 'overloaded', 'timeout', 'disconnect', 'invalid'] as const
export type ChaosKind = (typeof CHAOS_KINDS)[number]

export class Chaos {
  readonly armed: Record<ChaosKind, number> = { rate_limit: 0, overloaded: 0, timeout: 0, disconnect: 0, invalid: 0 }
  readonly rates: Record<ChaosKind, number> = { rate_limit: 0, overloaded: 0, timeout: 0, disconnect: 0, invalid: 0 }
  readonly fired: Record<ChaosKind, number> = { rate_limit: 0, overloaded: 0, timeout: 0, disconnect: 0, invalid: 0 }

  arm(counts: Partial<Record<ChaosKind, number>>): void {
    for (const kind of CHAOS_KINDS) {
      const n = counts[kind]
      if (n !== undefined) this.armed[kind] = Math.max(0, Math.floor(n))
    }
  }

  setRates(rates: Partial<Record<ChaosKind, number>>): void {
    for (const kind of CHAOS_KINDS) {
      const r = rates[kind]
      if (r !== undefined) this.rates[kind] = Math.min(1, Math.max(0, r))
    }
  }

  /** The failure to inject into the next call, if any. Consumes one armed count. */
  next(rand: () => number = Math.random): ChaosKind | null {
    for (const kind of CHAOS_KINDS) {
      if (this.armed[kind] > 0) {
        this.armed[kind]--
        this.fired[kind]++
        return kind
      }
    }
    for (const kind of CHAOS_KINDS) {
      if (this.rates[kind] > 0 && rand() < this.rates[kind]) {
        this.fired[kind]++
        return kind
      }
    }
    return null
  }

  reset(): void {
    for (const kind of CHAOS_KINDS) {
      this.armed[kind] = 0
      this.rates[kind] = 0
    }
  }

  snapshot() {
    return { armed: { ...this.armed }, rates: { ...this.rates }, fired: { ...this.fired } }
  }
}

/** Call accounting: totals, per outcome, and per eval run (from the X-Eval-Run-Id header). */
export class CallStats {
  total = 0
  active = 0
  maxActive = 0
  readonly byOutcome: Record<string, number> = {}
  readonly byRun = new Map<string, { calls: number; active: number; maxActive: number; firstAt: number; lastAt: number }>()

  start(runId: string | undefined, now = Date.now()): () => void {
    this.total++
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    let run = runId ? this.byRun.get(runId) : undefined
    if (runId && !run) {
      run = { calls: 0, active: 0, maxActive: 0, firstAt: now, lastAt: now }
      this.byRun.set(runId, run)
    }
    if (run) {
      run.calls++
      run.active++
      run.maxActive = Math.max(run.maxActive, run.active)
      run.lastAt = now
    }
    let done = false
    return () => {
      if (done) return
      done = true
      this.active--
      if (run) run.active--
    }
  }

  outcome(name: string): void {
    this.byOutcome[name] = (this.byOutcome[name] ?? 0) + 1
  }

  reset(): void {
    this.total = 0
    this.maxActive = this.active
    for (const k of Object.keys(this.byOutcome)) delete this.byOutcome[k]
    this.byRun.clear()
  }

  snapshot(runId?: string): CallSnapshot {
    const run = runId ? this.byRun.get(runId) : undefined
    const snap: CallSnapshot = { total: this.total, active: this.active, maxActive: this.maxActive, byOutcome: { ...this.byOutcome }, runs: this.byRun.size }
    if (runId) {
      snap.run = run
        ? { calls: run.calls, active: run.active, maxActive: run.maxActive, firstAt: new Date(run.firstAt).toISOString(), lastAt: new Date(run.lastAt).toISOString() }
        : { calls: 0, active: 0, maxActive: 0, firstAt: null, lastAt: null }
    }
    return snap
  }
}

export interface CallSnapshot {
  total: number
  active: number
  maxActive: number
  byOutcome: Record<string, number>
  runs: number
  run?: { calls: number; active: number; maxActive: number; firstAt: string | null; lastAt: string | null }
}
