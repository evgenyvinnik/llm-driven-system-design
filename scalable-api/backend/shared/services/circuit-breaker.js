import config from '../config/index.js';
import { CircuitOpenError } from '../utils/index.js';

/**
 * Circuit Breaker implementation for protecting against cascading failures
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

    console.warn(`Circuit breaker ${this.name} failure #${this.failures}:`, error.message);

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

    console.log(`Circuit breaker ${this.name}: ${oldState} -> ${newState}`);
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

export default CircuitBreaker;
