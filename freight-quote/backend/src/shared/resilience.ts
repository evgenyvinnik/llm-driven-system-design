/**
 * Single-flight request coalescing and hedged requests.
 * @module shared/resilience
 */

/**
 * Collapses identical concurrent calls into one: the first caller for a key
 * runs `fn`, later callers get the same promise until it settles. The key must
 * contain everything that changes the answer (for pricing, the contract id),
 * or one customer would receive another's result.
 */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<unknown>>()

  do<T>(key: string, fn: () => Promise<T>): { promise: Promise<T>; shared: boolean } {
    const existing = this.inflight.get(key)
    if (existing) return { promise: existing as Promise<T>, shared: true }
    const promise = fn().finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return { promise, shared: false }
  }

  get size(): number {
    return this.inflight.size
  }
}

/**
 * Limits hedges to a share of calls. Each call adds `pct/100` of a token and a
 * hedge spends one, so at 10% no more than about one call in ten is
 * duplicated, whatever the latency does. Without this, a dependency that
 * slows down for everyone would receive twice the load just as it struggles.
 */
export class HedgeBudget {
  /** Kept in hundredths of a token so that ten calls at 10% add exactly one token. */
  private centiTokens: number

  constructor(
    private pct: number,
    private readonly cap = 5,
  ) {
    this.centiTokens = cap * 100
  }

  setPct(pct: number): void {
    this.pct = pct
  }

  onCall(): void {
    this.centiTokens = Math.min(this.cap * 100, this.centiTokens + Math.round(this.pct))
  }

  tryTake(): boolean {
    if (this.centiTokens >= 100) {
      this.centiTokens -= 100
      return true
    }
    return false
  }
}

export interface HedgeOptions {
  /** Start the backup attempt if the first hasn't answered after this long. */
  delayMs: number
  /** Asked when the delay expires; false skips the hedge (budget spent, circuit half-open). */
  canHedge: () => boolean
  onHedge?: () => void
  onHedgeWin?: () => void
}

/**
 * Runs `attempt`; if it hasn't settled after `delayMs`, starts a second
 * attempt and returns whichever succeeds first, aborting the other. An
 * attempt that fails before the hedge starts fails the call (a fast error is
 * not a reason to hedge; that is what retries and breakers are for). Once
 * both run, the call fails only when both have failed.
 */
export function hedged<T>(attempt: (signal: AbortSignal, n: 1 | 2) => Promise<T>, opts: HedgeOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = []
    let settled = false
    let launched = 0
    let failures = 0
    const finish = (fn: () => void) => {
      settled = true
      clearTimeout(timer)
      fn()
    }

    const launch = (n: 1 | 2) => {
      launched += 1
      const controller = new AbortController()
      controllers.push(controller)
      attempt(controller.signal, n).then(
        (value) => {
          if (settled) return
          for (const c of controllers) if (c !== controller) c.abort()
          if (n === 2) opts.onHedgeWin?.()
          finish(() => resolve(value))
        },
        (err: unknown) => {
          if (settled) return
          failures += 1
          if (launched === 1 || failures >= launched) finish(() => reject(err))
        },
      )
    }

    launch(1)
    const timer = setTimeout(() => {
      if (settled || !opts.canHedge()) return
      opts.onHedge?.()
      launch(2)
    }, opts.delayMs)
  })
}

/** Nearest-rank percentile of a sample; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}
