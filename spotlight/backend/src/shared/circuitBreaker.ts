import CircuitBreaker from 'opossum';
import { circuitBreakerState, circuitBreakerTripsTotal } from './metrics.js';
import { logCircuitBreakerState } from './logger.js';

// Circuit breaker state mapping for metrics
const STATE_MAP = {
  'closed': 0,
  'halfOpen': 1,
  'open': 2
} as const;

export interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  rollingCountTimeout?: number;
  rollingCountBuckets?: number;
}

/**
 * Default circuit breaker configuration for index operations
 */
const DEFAULT_INDEX_OPTIONS: CircuitBreakerOptions = {
  timeout: 10000,           // 10 seconds timeout for index operations
  errorThresholdPercentage: 50,  // Open if 50% of requests fail
  resetTimeout: 30000,      // Wait 30 seconds before half-open
  volumeThreshold: 5,       // Minimum 5 requests before calculating error percentage
  rollingCountTimeout: 10000,    // Rolling window of 10 seconds
  rollingCountBuckets: 10   // 10 buckets for rolling statistics
};

/**
 * Circuit breaker configuration for Elasticsearch operations
 */
const ES_OPTIONS: CircuitBreakerOptions = {
  timeout: 5000,            // 5 seconds timeout
  errorThresholdPercentage: 30,  // Open if 30% of requests fail
  resetTimeout: 60000,      // Wait 60 seconds before half-open
  volumeThreshold: 3,       // Only need 3 failures
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10
};

// Type for the circuit breaker
type CircuitBreakerInstance = CircuitBreaker<unknown[], unknown>;

// Map to store circuit breakers by name
const circuitBreakers = new Map<string, CircuitBreakerInstance>();

export interface CircuitBreakerState {
  state: 'OPEN' | 'HALF_OPEN' | 'CLOSED';
  stats: {
    failures: number;
    successes: number;
    rejects: number;
    timeouts: number;
  };
}

/**
 * Create or get a circuit breaker for a specific operation
 */
export function createCircuitBreaker<T>(
  name: string,
  action: (...args: unknown[]) => Promise<T>,
  options: CircuitBreakerOptions = {}
): CircuitBreakerInstance {
  if (circuitBreakers.has(name)) {
    return circuitBreakers.get(name)!;
  }

  const mergedOptions = {
    ...DEFAULT_INDEX_OPTIONS,
    ...options,
    name
  };

  const breaker = new CircuitBreaker(action, mergedOptions);

  // Set up event handlers for monitoring
  breaker.on('open', () => {
    circuitBreakerState.labels(name).set(STATE_MAP.open);
    circuitBreakerTripsTotal.labels(name).inc();
    logCircuitBreakerState({ name, state: 'OPEN', failures: breaker.stats.failures });
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.labels(name).set(STATE_MAP.halfOpen);
    logCircuitBreakerState({ name, state: 'HALF_OPEN', failures: breaker.stats.failures });
  });

  breaker.on('close', () => {
    circuitBreakerState.labels(name).set(STATE_MAP.closed);
    logCircuitBreakerState({ name, state: 'CLOSED', failures: 0 });
  });

  breaker.on('timeout', () => {
    logCircuitBreakerState({ name, state: 'TIMEOUT', failures: breaker.stats.failures });
  });

  breaker.on('reject', () => {
    logCircuitBreakerState({ name, state: 'REJECTED', failures: breaker.stats.failures });
  });

  // Initialize metrics
  circuitBreakerState.labels(name).set(STATE_MAP.closed);

  circuitBreakers.set(name, breaker);
  return breaker;
}

/**
 * Create a circuit breaker specifically for Elasticsearch index operations
 */
export function createIndexCircuitBreaker<T>(
  indexName: string,
  action: (...args: unknown[]) => Promise<T>
): CircuitBreakerInstance {
  return createCircuitBreaker(`es_index_${indexName}`, action, ES_OPTIONS);
}

/**
 * Execute an operation with circuit breaker protection
 */
export async function withCircuitBreaker<T>(
  breakerName: string,
  action: () => Promise<T>,
  fallbackValue: T | null = null
): Promise<T | null> {
  let breaker = circuitBreakers.get(breakerName);

  if (!breaker) {
    breaker = createCircuitBreaker(breakerName, action);
  }

  try {
    // For dynamic actions, we need to fire with the action
    return await breaker.fire() as T;
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'EOPENBREAKER') {
      // Circuit is open, return fallback
      return fallbackValue;
    }
    throw error;
  }
}

/**
 * Get the current state of all circuit breakers
 */
export function getAllCircuitBreakerStates(): Record<string, CircuitBreakerState> {
  const states: Record<string, CircuitBreakerState> = {};
  for (const [name, breaker] of circuitBreakers) {
    states[name] = {
      state: breaker.opened ? 'OPEN' : (breaker.halfOpen ? 'HALF_OPEN' : 'CLOSED'),
      stats: {
        failures: breaker.stats.failures,
        successes: breaker.stats.successes,
        rejects: breaker.stats.rejects,
        timeouts: breaker.stats.timeouts
      }
    };
  }
  return states;
}

/**
 * Get a specific circuit breaker by name
 */
export function getCircuitBreaker(name: string): CircuitBreakerInstance | undefined {
  return circuitBreakers.get(name);
}

/**
 * Wrapper class for index operations with built-in circuit breaker
 */
export class ProtectedIndexOperation {
  private name: string;
  private options: CircuitBreakerOptions;
  private breaker: CircuitBreakerInstance | null;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.options = { ...ES_OPTIONS, ...options };
    this.breaker = null;
  }

  /**
   * Execute an index operation with circuit breaker protection
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.breaker) {
      this.breaker = createCircuitBreaker(this.name, operation, this.options);
    }

    return this.breaker.fire() as Promise<T>;
  }

  /**
   * Check if the circuit is open
   */
  isOpen(): boolean {
    return this.breaker?.opened ?? false;
  }

  /**
   * Get the current state
   */
  getState(): 'OPEN' | 'HALF_OPEN' | 'CLOSED' {
    if (!this.breaker) return 'CLOSED';
    if (this.breaker.opened) return 'OPEN';
    if (this.breaker.halfOpen) return 'HALF_OPEN';
    return 'CLOSED';
  }
}

// Pre-configured circuit breakers for common operations
export const indexOperationsBreaker: Record<string, CircuitBreakerInstance | null> = {
  files: null,
  apps: null,
  contacts: null,
  web: null
};

/**
 * Initialize circuit breakers for all index types
 */
export function initializeIndexBreakers(
  indexFn: (indexType: string, params: unknown) => Promise<unknown>
): void {
  for (const indexType of Object.keys(indexOperationsBreaker)) {
    indexOperationsBreaker[indexType] = createCircuitBreaker(
      `index_${indexType}`,
      async (params: unknown) => indexFn(indexType, params),
      ES_OPTIONS
    );
  }
}

export default {
  createCircuitBreaker,
  createIndexCircuitBreaker,
  withCircuitBreaker,
  getAllCircuitBreakerStates,
  getCircuitBreaker,
  ProtectedIndexOperation,
  indexOperationsBreaker,
  initializeIndexBreakers
};
