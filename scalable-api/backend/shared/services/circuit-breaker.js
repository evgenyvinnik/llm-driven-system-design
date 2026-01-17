import CircuitBreakerLib from 'opossum';
import config from '../config/index.js';
import { CircuitOpenError } from '../utils/index.js';
import { metricsService } from './metrics.js';
import logger from './logger.js';

/**
 * Circuit Breaker implementation for protecting against cascading failures
 *
 * WHY circuit breakers prevent cascade failures:
 * - When a downstream service fails, requests pile up waiting for timeouts
 * - This exhausts connection pools and threads in the calling service
 * - The calling service then fails, cascading to its callers
 * - Circuit breakers "fail fast" when a service is down, preventing resource exhaustion
 * - Half-open state allows gradual recovery testing without overwhelming the recovering service
 *
 * This implementation wraps the opossum library for production-grade circuit breaking
 * while maintaining backward compatibility with our simpler implementation.
 */
export class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || config.circuitBreaker.failureThreshold;
    this.resetTimeout = options.resetTimeout || config.circuitBreaker.resetTimeout;
    this.halfOpenRequests = options.halfOpenRequests || config.circuitBreaker.halfOpenRequests;

    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
    this.halfOpenCount = 0;
    this.log = logger.child({ circuitBreaker: name });

    // Statistics
    this.stats = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
      stateChanges: [],
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute(fn) {
    this.stats.totalCalls++;

    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.resetTimeout) {
        this.transitionTo('half-open');
        this.halfOpenCount = 0;
      } else {
        this.stats.rejectedCalls++;
        throw new CircuitOpenError(`Circuit breaker ${this.name} is open`);
      }
    }

    if (this.state === 'half-open') {
      this.halfOpenCount++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  onSuccess() {
    this.stats.successfulCalls++;

    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.halfOpenRequests) {
        this.transitionTo('closed');
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      // Gradually reduce failure count on success
      this.failures = Math.max(0, this.failures - 1);
    }
  }

  /**
   * Handle failed execution
   */
  onFailure(error) {
    this.stats.failedCalls++;
    this.failures++;
    this.lastFailure = Date.now();

    this.log.warn({ failures: this.failures, error: error.message }, 'Circuit breaker failure');

    if (this.state === 'half-open') {
      this.transitionTo('open');
    } else if (this.failures >= this.failureThreshold) {
      this.transitionTo('open');
    }
  }

  /**
   * Transition to a new state
   */
  transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;

    this.stats.stateChanges.push({
      from: oldState,
      to: newState,
      timestamp: new Date().toISOString(),
    });

    this.log.info({ from: oldState, to: newState }, 'Circuit breaker state change');

    // Record state change in metrics
    metricsService.recordCircuitBreakerState(this.name, newState, this.stats);
  }

  /**
   * Get current state and statistics
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
      stats: this.stats,
    };
  }

  /**
   * Force the circuit to open
   */
  open() {
    this.transitionTo('open');
    this.lastFailure = Date.now();
  }

  /**
   * Force the circuit to close
   */
  close() {
    this.transitionTo('closed');
    this.failures = 0;
    this.successes = 0;
  }

  /**
   * Reset all statistics
   */
  resetStats() {
    this.stats = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
      stateChanges: [],
    };
  }
}

/**
 * Circuit Breaker Registry for managing multiple breakers
 */
export class CircuitBreakerRegistry {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Get or create a circuit breaker
   */
  get(name, options = {}) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker(name, options));
    }
    return this.breakers.get(name);
  }

  /**
   * Get all circuit breaker states
   */
  getAll() {
    const states = {};
    for (const [name, breaker] of this.breakers) {
      states[name] = breaker.getState();
    }
    return states;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.close();
      breaker.resetStats();
    }
  }
}

// Singleton instance
export const circuitBreakerRegistry = new CircuitBreakerRegistry();

/**
 * Production-grade circuit breaker using opossum library
 *
 * Use this for downstream service calls that need more sophisticated
 * circuit breaking features like:
 * - Configurable timeout
 * - Fallback functions
 * - Volume threshold (min requests before opening)
 * - Error percentage threshold
 */
export class OpossumCircuitBreaker {
  constructor(name, action, options = {}) {
    this.name = name;
    this.log = logger.child({ circuitBreaker: name });

    const defaultOptions = {
      timeout: options.timeout || 10000, // 10 seconds
      errorThresholdPercentage: options.errorThresholdPercentage || 50,
      resetTimeout: options.resetTimeout || config.circuitBreaker.resetTimeout,
      volumeThreshold: options.volumeThreshold || 5, // Min requests before opening
    };

    this.breaker = new CircuitBreakerLib(action, defaultOptions);

    // Set up event handlers
    this.breaker.on('open', () => {
      this.log.warn('Circuit opened');
      metricsService.recordCircuitBreakerState(name, 'open', this.getStats());
    });

    this.breaker.on('halfOpen', () => {
      this.log.info('Circuit half-open');
      metricsService.recordCircuitBreakerState(name, 'half-open', this.getStats());
    });

    this.breaker.on('close', () => {
      this.log.info('Circuit closed');
      metricsService.recordCircuitBreakerState(name, 'closed', this.getStats());
    });

    this.breaker.on('fallback', () => {
      this.log.debug('Fallback executed');
      metricsService.increment('circuit_breaker_fallbacks_total', { name });
    });

    this.breaker.on('reject', () => {
      this.log.warn('Request rejected (circuit open)');
      metricsService.increment('circuit_breaker_rejects_total', { name });
    });

    this.breaker.on('timeout', () => {
      this.log.warn('Request timed out');
      metricsService.increment('circuit_breaker_timeouts_total', { name });
    });
  }

  /**
   * Execute the protected action
   */
  async fire(...args) {
    return this.breaker.fire(...args);
  }

  /**
   * Set fallback function
   */
  fallback(fn) {
    this.breaker.fallback(fn);
    return this;
  }

  /**
   * Get current state
   */
  get state() {
    if (this.breaker.opened) return 'open';
    if (this.breaker.halfOpen) return 'half-open';
    return 'closed';
  }

  /**
   * Get statistics
   */
  getStats() {
    const stats = this.breaker.stats;
    return {
      totalCalls: stats.fires || 0,
      successfulCalls: stats.successes || 0,
      failedCalls: stats.failures || 0,
      rejectedCalls: stats.rejects || 0,
      timeouts: stats.timeouts || 0,
      fallbacks: stats.fallbacks || 0,
    };
  }

  /**
   * Get full state for monitoring
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      stats: this.getStats(),
      status: this.breaker.status,
    };
  }

  /**
   * Force open
   */
  open() {
    this.breaker.open();
  }

  /**
   * Force close
   */
  close() {
    this.breaker.close();
  }
}

export default CircuitBreaker;
