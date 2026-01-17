/**
 * Circuit breaker pattern implementation for external service calls.
 * Prevents cascade failures by failing fast when a service is unhealthy.
 *
 * WHY: When external services (MinIO, RabbitMQ, PostgreSQL) fail repeatedly,
 * continuing to call them wastes resources and delays responses. Circuit breakers
 * detect failure patterns and "open" to reject requests immediately, giving the
 * downstream service time to recover. This prevents a single failing component
 * from bringing down the entire system.
 *
 * @module shared/circuitBreaker
 */

import { logger } from './logger.js'

/**
 * Circuit breaker states:
 * - CLOSED: Normal operation, all requests pass through
 * - OPEN: Failing fast, all requests rejected immediately
 * - HALF_OPEN: Testing recovery, allowing limited requests through
 */
export type CircuitState = 'closed' | 'open' | 'half-open'

/**
 * Configuration options for a circuit breaker instance.
 */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number
  /** Time in ms to wait before transitioning from open to half-open */
  resetTimeout: number
  /** Number of successful calls in half-open to close the circuit */
  successThreshold: number
  /** Human-readable name for logging */
  name: string
  /** Optional callback when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState) => void
}

/**
 * Default configuration for circuit breakers.
 * Conservative settings suitable for local development.
 */
const DEFAULT_OPTIONS: Omit<CircuitBreakerOptions, 'name'> = {
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 2,
}

/**
 * Circuit breaker implementation for wrapping external service calls.
 * Tracks failures and opens the circuit to prevent cascade failures.
 *
 * @example
 * ```typescript
 * const minioBreaker = new CircuitBreaker({ name: 'minio', failureThreshold: 5, resetTimeout: 30000 })
 *
 * try {
 *   const result = await minioBreaker.execute(() => minio.putObject(...))
 * } catch (err) {
 *   if (err.message === 'Circuit breaker is open') {
 *     // Return 503 to client, service is temporarily unavailable
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failures = 0
  private successes = 0
  private lastFailureTime = 0
  private options: CircuitBreakerOptions

  constructor(options: Partial<CircuitBreakerOptions> & { name: string }) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * Current state of the circuit breaker.
   */
  getState(): CircuitState {
    return this.state
  }

  /**
   * Number of consecutive failures recorded.
   */
  getFailureCount(): number {
    return this.failures
  }

  /**
   * Transitions the circuit breaker to a new state.
   * Logs the transition and calls the optional onStateChange callback.
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return

    const oldState = this.state
    this.state = newState

    logger.info({
      msg: 'Circuit breaker state change',
      circuitBreaker: this.options.name,
      from: oldState,
      to: newState,
      failures: this.failures,
    })

    if (this.options.onStateChange) {
      this.options.onStateChange(oldState, newState)
    }
  }

  /**
   * Executes a function through the circuit breaker.
   * Rejects immediately if the circuit is open, otherwise executes the function
   * and tracks success/failure for state management.
   *
   * @param fn - Async function to execute
   * @returns Promise resolving to the function's result
   * @throws Error if circuit is open or the function throws
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from open to half-open
    if (this.state === 'open') {
      const timeSinceFailure = Date.now() - this.lastFailureTime
      if (timeSinceFailure >= this.options.resetTimeout) {
        this.transitionTo('half-open')
        this.successes = 0
      } else {
        throw new CircuitBreakerOpenError(
          `Circuit breaker '${this.options.name}' is open`,
          this.options.name,
          this.options.resetTimeout - timeSinceFailure
        )
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  /**
   * Records a successful call.
   * In half-open state, may transition to closed after enough successes.
   */
  private onSuccess(): void {
    this.failures = 0

    if (this.state === 'half-open') {
      this.successes++
      if (this.successes >= this.options.successThreshold) {
        this.transitionTo('closed')
      }
    }
  }

  /**
   * Records a failed call.
   * May transition to open state after reaching the failure threshold.
   */
  private onFailure(): void {
    this.failures++
    this.lastFailureTime = Date.now()

    if (this.state === 'half-open') {
      // Any failure in half-open reopens the circuit
      this.transitionTo('open')
    } else if (this.failures >= this.options.failureThreshold) {
      this.transitionTo('open')
    }
  }

  /**
   * Manually resets the circuit breaker to closed state.
   * Useful for admin-initiated recovery or testing.
   */
  reset(): void {
    this.failures = 0
    this.successes = 0
    this.transitionTo('closed')
  }

  /**
   * Returns circuit breaker status for health checks.
   */
  getStatus(): {
    name: string
    state: CircuitState
    failures: number
    lastFailureTime: number | null
  } {
    return {
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime || null,
    }
  }
}

/**
 * Custom error for when circuit breaker is open.
 * Includes retry-after hint for clients.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(
    message: string,
    public readonly circuitName: string,
    public readonly retryAfterMs: number
  ) {
    super(message)
    this.name = 'CircuitBreakerOpenError'
  }
}

// Pre-configured circuit breakers for common services
// These can be imported and used directly in other modules

/**
 * Circuit breaker for MinIO object storage operations.
 * More tolerant of failures since object storage is critical for core functionality.
 */
export const minioCircuitBreaker = new CircuitBreaker({
  name: 'minio',
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  successThreshold: 2,
})

/**
 * Circuit breaker for RabbitMQ message queue operations.
 * Longer reset timeout since queue operations can be queued in a dead-letter table.
 */
export const rabbitCircuitBreaker = new CircuitBreaker({
  name: 'rabbitmq',
  failureThreshold: 5,
  resetTimeout: 60000, // 60 seconds
  successThreshold: 2,
})

/**
 * Circuit breaker for PostgreSQL database operations.
 * Shorter reset timeout for faster recovery detection.
 */
export const postgresCircuitBreaker = new CircuitBreaker({
  name: 'postgres',
  failureThreshold: 3,
  resetTimeout: 15000, // 15 seconds
  successThreshold: 2,
})

/**
 * Returns status of all pre-configured circuit breakers.
 * Useful for health check endpoints.
 */
export function getAllCircuitBreakerStatus(): ReturnType<CircuitBreaker['getStatus']>[] {
  return [
    minioCircuitBreaker.getStatus(),
    rabbitCircuitBreaker.getStatus(),
    postgresCircuitBreaker.getStatus(),
  ]
}
