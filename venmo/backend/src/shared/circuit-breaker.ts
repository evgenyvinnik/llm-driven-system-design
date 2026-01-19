/**
 * Circuit Breaker Pattern Implementation
 *
 * WHY circuit breakers are essential for bank integrations:
 *
 * 1. PROTECTION: When a bank API is down or slow, without a circuit breaker,
 *    every request would wait for timeout (e.g., 30s), consuming threads and
 *    eventually bringing down the entire payment system.
 *
 * 2. FAST FAILURE: Once the circuit opens, requests fail immediately instead of
 *    waiting for timeouts. Users get instant feedback to try again later.
 *
 * 3. GRACEFUL RECOVERY: The half-open state allows gradual recovery testing
 *    without overwhelming a recovering service with full traffic.
 *
 * 4. CASCADING FAILURE PREVENTION: If bank API is slow, our service becomes slow,
 *    then the client becomes slow, then the app becomes unresponsive. Circuit
 *    breakers stop this cascade at the first point of failure.
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failures exceeded threshold, requests fail fast
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 */

import { logger } from './logger.js';
import { circuitBreakerState, circuitBreakerFailures } from './metrics.js';

export const STATES = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
} as const;

export type CircuitState = typeof STATES[keyof typeof STATES];

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenRequests?: number;
  timeout?: number;
}

export interface CircuitBreakerStats {
  name: string;
  state: string;
  failures: number;
  failureThreshold: number;
  lastFailureTime: number | null;
  halfOpenAttempts: number;
  halfOpenRequests: number;
  timeUntilRetry: number | null;
}

interface CircuitBreakerError extends Error {
  code?: string;
}

export class CircuitBreaker {
  private name: string;
  private failureThreshold: number;
  private resetTimeout: number;
  private halfOpenRequests: number;
  private timeout: number;
  private state: CircuitState;
  private failures: number;
  private successes: number;
  private lastFailureTime: number | null;
  private halfOpenAttempts: number;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.halfOpenRequests = options.halfOpenRequests || 3;
    this.timeout = options.timeout || 10000;

    // State tracking
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;

    // Update metrics
    this._updateMetrics();

    logger.info({
      event: 'circuit_breaker_created',
      circuitBreaker: this.name,
      config: {
        failureThreshold: this.failureThreshold,
        resetTimeout: this.resetTimeout,
        halfOpenRequests: this.halfOpenRequests,
        timeout: this.timeout,
      },
    });
  }

  /**
   * Get current state as string
   */
  getState(): string {
    switch (this.state) {
      case STATES.CLOSED:
        return 'CLOSED';
      case STATES.HALF_OPEN:
        return 'HALF_OPEN';
      case STATES.OPEN:
        return 'OPEN';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * Update Prometheus metrics for this circuit breaker
   */
  private _updateMetrics(): void {
    circuitBreakerState.set({ service: this.name }, this.state);
  }

  /**
   * Check if circuit breaker allows requests
   */
  canExecute(): boolean {
    if (this.state === STATES.CLOSED) {
      return true;
    }

    if (this.state === STATES.OPEN) {
      // Check if enough time has passed to try half-open
      const timeSinceFailure = Date.now() - (this.lastFailureTime || 0);
      if (timeSinceFailure >= this.resetTimeout) {
        this._transitionToHalfOpen();
        return true;
      }
      return false;
    }

    // HALF_OPEN - allow limited requests to test
    return true;
  }

  /**
   * Execute an operation with circuit breaker protection
   */
  async execute<T>(
    operation: () => Promise<T>,
    fallback: ((error: Error) => T) | null = null
  ): Promise<T> {
    if (!this.canExecute()) {
      const error: CircuitBreakerError = new Error(`Circuit breaker ${this.name} is OPEN`);
      error.code = 'CIRCUIT_BREAKER_OPEN';

      logger.warn({
        event: 'circuit_breaker_rejected',
        circuitBreaker: this.name,
        state: this.getState(),
        timeUntilRetry: this.resetTimeout - (Date.now() - (this.lastFailureTime || 0)),
      });

      if (fallback) {
        return fallback(error);
      }
      throw error;
    }

    try {
      // Wrap operation with timeout
      const result = await this._executeWithTimeout(operation);
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error as Error);
      throw error;
    }
  }

  /**
   * Execute operation with timeout
   */
  private async _executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          const error: CircuitBreakerError = new Error(`Circuit breaker ${this.name} timeout after ${this.timeout}ms`);
          error.code = 'CIRCUIT_BREAKER_TIMEOUT';
          reject(error);
        }, this.timeout);
      }),
    ]);
  }

  /**
   * Handle successful operation
   */
  private _onSuccess(): void {
    this.failures = 0;

    if (this.state === STATES.HALF_OPEN) {
      this.halfOpenAttempts++;

      logger.debug({
        event: 'circuit_breaker_half_open_success',
        circuitBreaker: this.name,
        successCount: this.halfOpenAttempts,
        requiredSuccesses: this.halfOpenRequests,
      });

      if (this.halfOpenAttempts >= this.halfOpenRequests) {
        this._transitionToClosed();
      }
    }
  }

  /**
   * Handle failed operation
   */
  private _onFailure(error: Error): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    // Update failure metrics
    circuitBreakerFailures.inc({ service: this.name });

    logger.warn({
      event: 'circuit_breaker_failure',
      circuitBreaker: this.name,
      state: this.getState(),
      failures: this.failures,
      threshold: this.failureThreshold,
      error: error.message,
    });

    // If in half-open state, any failure opens the circuit immediately
    if (this.state === STATES.HALF_OPEN) {
      this._transitionToOpen();
      return;
    }

    // Check if we've exceeded the failure threshold
    if (this.failures >= this.failureThreshold) {
      this._transitionToOpen();
    }
  }

  /**
   * Transition to OPEN state
   */
  private _transitionToOpen(): void {
    const previousState = this.getState();
    this.state = STATES.OPEN;
    this._updateMetrics();

    logger.error({
      event: 'circuit_breaker_opened',
      circuitBreaker: this.name,
      previousState,
      failures: this.failures,
      retryAfterMs: this.resetTimeout,
    });
  }

  /**
   * Transition to HALF_OPEN state
   */
  private _transitionToHalfOpen(): void {
    const previousState = this.getState();
    this.state = STATES.HALF_OPEN;
    this.halfOpenAttempts = 0;
    this._updateMetrics();

    logger.info({
      event: 'circuit_breaker_half_open',
      circuitBreaker: this.name,
      previousState,
    });
  }

  /**
   * Transition to CLOSED state
   */
  private _transitionToClosed(): void {
    const previousState = this.getState();
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.halfOpenAttempts = 0;
    this._updateMetrics();

    logger.info({
      event: 'circuit_breaker_closed',
      circuitBreaker: this.name,
      previousState,
    });
  }

  /**
   * Force open the circuit (for manual intervention)
   */
  forceOpen(): void {
    logger.warn({
      event: 'circuit_breaker_force_opened',
      circuitBreaker: this.name,
    });
    this._transitionToOpen();
  }

  /**
   * Force close the circuit (for manual intervention)
   */
  forceClose(): void {
    logger.info({
      event: 'circuit_breaker_force_closed',
      circuitBreaker: this.name,
    });
    this._transitionToClosed();
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.getState(),
      failures: this.failures,
      failureThreshold: this.failureThreshold,
      lastFailureTime: this.lastFailureTime,
      halfOpenAttempts: this.halfOpenAttempts,
      halfOpenRequests: this.halfOpenRequests,
      timeUntilRetry:
        this.state === STATES.OPEN
          ? Math.max(0, this.resetTimeout - (Date.now() - (this.lastFailureTime || 0)))
          : null,
    };
  }
}

// Pre-configured circuit breakers for external services
export const bankApiCircuit = new CircuitBreaker('bank-api', {
  failureThreshold: 3,
  resetTimeout: 60000, // 1 minute
  halfOpenRequests: 3,
  timeout: 15000, // Bank APIs can be slow
});

export const cardNetworkCircuit = new CircuitBreaker('card-network', {
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  halfOpenRequests: 3,
  timeout: 10000,
});

export const achNetworkCircuit = new CircuitBreaker('ach-network', {
  failureThreshold: 3,
  resetTimeout: 120000, // 2 minutes (ACH is batch-oriented)
  halfOpenRequests: 2,
  timeout: 30000,
});
