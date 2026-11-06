/**
 * One opossum circuit breaker per dependency, per process. Timeouts are
 * enforced by the deadline-aware client, not by opossum, so a call that blows
 * its budget counts as a failure. A rejected input (422) is a business answer,
 * not a dependency failure, and does not count toward opening the circuit.
 * @module shared/breakers
 */
import CircuitBreaker from 'opossum'
import { DEPENDENCIES, type Dependency } from './domain.js'
import { DependencyError } from './dependency-client.js'
import { breakerState } from './metrics.js'

export type BreakerState = 'closed' | 'open' | 'halfOpen'

export interface BreakerOptions {
  errorThresholdPercentage: number
  resetTimeout: number
  rollingCountTimeout: number
  volumeThreshold: number
}

export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  errorThresholdPercentage: 50,
  resetTimeout: 5_000,
  rollingCountTimeout: 10_000,
  volumeThreshold: 10,
}

type Action = () => Promise<unknown>

export class DependencyBreakers {
  private readonly breakers: Record<Dependency, CircuitBreaker<[Action], unknown>>
  private readonly openedAt = new Map<Dependency, number>()

  constructor(
    caller: string,
    onTransition: (dep: Dependency, state: BreakerState, openMs: number | null) => void,
    options: BreakerOptions = DEFAULT_BREAKER_OPTIONS,
  ) {
    this.breakers = {} as Record<Dependency, CircuitBreaker<[Action], unknown>>
    for (const dep of DEPENDENCIES) {
      const breaker = new CircuitBreaker<[Action], unknown>((action: Action) => action(), {
        ...options,
        timeout: false,
        rollingCountBuckets: 10,
        name: `${caller}:${dep}`,
        errorFilter: (err: unknown) => err instanceof DependencyError && err.kind === 'rejected',
      })
      breaker.on('open', () => {
        this.openedAt.set(dep, Date.now())
        breakerState.set({ dependency: dep, caller }, 2)
        onTransition(dep, 'open', null)
      })
      breaker.on('halfOpen', () => {
        breakerState.set({ dependency: dep, caller }, 1)
        onTransition(dep, 'halfOpen', null)
      })
      breaker.on('close', () => {
        const opened = this.openedAt.get(dep)
        this.openedAt.delete(dep)
        breakerState.set({ dependency: dep, caller }, 0)
        onTransition(dep, 'closed', opened ? Date.now() - opened : null)
      })
      breakerState.set({ dependency: dep, caller }, 0)
      this.breakers[dep] = breaker
    }
  }

  async fire<T>(dep: Dependency, action: () => Promise<T>): Promise<T> {
    try {
      return (await this.breakers[dep].fire(action)) as T
    } catch (err) {
      if ((err as { code?: string }).code === 'EOPENBREAKER') {
        throw new DependencyError(dep, 'short_circuit', `${dep}: circuit open`)
      }
      throw err
    }
  }

  state(dep: Dependency): BreakerState {
    const b = this.breakers[dep]
    if (b.opened) return 'open'
    if (b.halfOpen) return 'halfOpen'
    return 'closed'
  }

  states(): Record<Dependency, BreakerState> {
    return Object.fromEntries(DEPENDENCIES.map((d) => [d, this.state(d)])) as Record<Dependency, BreakerState>
  }

  shutdown(): void {
    for (const dep of DEPENDENCIES) this.breakers[dep].shutdown()
  }
}
