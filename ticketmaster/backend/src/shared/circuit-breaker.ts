/**
 * Circuit breaker pattern implementation for fault tolerance.
 * Protects external service calls (like payment processing) from cascading failures.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit is tripped, requests fail immediately
 * - HALF_OPEN: Testing if service has recovered
 */
import logger, { businessLogger } from './logger.js';
import { circuitBreakerState, circuitBreakerTrips } from './metrics.js';

/** Circuit breaker states */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/** Configuration options for the circuit breaker */
export interface CircuitBreakerOptions {
  /** Name for logging and metrics */
  name: string;
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms to wait before attempting recovery */
  resetTimeout: number;
  /** Number of successful calls in half-open state to close circuit */
  successThreshold: number;
  /** Timeout for individual calls in ms */
  callTimeout?: number;
}

/**
 * Circuit breaker class that wraps async operations.
 * Automatically opens on repeated failures and tests recovery periodically.
 */
export class CircuitBreaker<T> {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(options: CircuitBreakerOptions) {
    this.options = {
      callTimeout: 5000,
      ...options,
    };
    this.updateMetrics();
  }

  /**
   * Executes an operation through the circuit breaker.
   * Fails fast if circuit is open, otherwise executes the operation.
   *
   * @param operation - The async operation to execute
   * @returns The result of the operation
   * @throws Error if circuit is open or operation fails
   */
  async execute(operation: () => Promise<T>): Promise<T> {
    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.transitionTo(CircuitState.HALF_OPEN);
      } else {
        throw new Error(`Circuit breaker ${this.options.name} is open`);
      }
    }

    try {
      const result = await this.executeWithTimeout(operation);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Gets the current circuit state.
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Gets the current failure count.
   */
  getFailureCount(): number {
    return this.failures;
  }

  /**
   * Manually resets the circuit breaker to closed state.
   * Use with caution - typically for testing or manual intervention.
   */
  reset(): void {
    this.transitionTo(CircuitState.CLOSED);
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }

  /**
   * Executes an operation with a timeout.
   */
  private async executeWithTimeout(operation: () => Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Operation timed out after ${this.options.callTimeout}ms`));
      }, this.options.callTimeout);
    });

    return Promise.race([operation(), timeoutPromise]);
  }

  /**
   * Called when an operation succeeds.
   */
  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.options.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
        this.failures = 0;
        this.successes = 0;
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success in closed state
      this.failures = 0;
    }
  }

  /**
   * Called when an operation fails.
   */
  private onFailure(error: unknown): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    logger.warn({
      msg: 'Circuit breaker operation failed',
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      error: error instanceof Error ? error.message : String(error),
    });

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state trips the circuit again
      this.transitionTo(CircuitState.OPEN);
      this.successes = 0;
    } else if (this.state === CircuitState.CLOSED && this.failures >= this.options.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
      circuitBreakerTrips.inc({ name: this.options.name });
    }
  }

  /**
   * Checks if enough time has passed to attempt recovery.
   */
  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return true;
    return Date.now() - this.lastFailureTime >= this.options.resetTimeout;
  }

  /**
   * Transitions to a new state with logging and metrics.
   */
  private transitionTo(newState: CircuitState): void {
    const previousState = this.state;
    this.state = newState;
    this.updateMetrics();

    businessLogger.circuitBreakerStateChange({
      name: this.options.name,
      previousState,
      newState,
      failures: this.failures,
    });
  }

  /**
   * Updates Prometheus metrics for circuit state.
   */
  private updateMetrics(): void {
    const stateValue =
      this.state === CircuitState.CLOSED ? 0 :
      this.state === CircuitState.OPEN ? 1 : 2;
    circuitBreakerState.set({ name: this.options.name }, stateValue);
  }
}

/**
 * Creates a circuit breaker for payment processing.
 * Configured with appropriate thresholds for payment failures.
 */
export function createPaymentCircuitBreaker() {
  return new CircuitBreaker<{
    success: boolean;
    transactionId?: string;
    error?: string;
  }>({
    name: 'payment_processor',
    failureThreshold: 5,
    resetTimeout: 30000, // 30 seconds
    successThreshold: 2,
    callTimeout: 10000, // 10 seconds
  });
}
