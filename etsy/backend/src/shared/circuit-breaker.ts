import CircuitBreaker from 'opossum';
import { circuitBreakerState, circuitBreakerFailures } from './metrics.js';
import { createLogger } from './logger.js';

const logger = createLogger('circuit-breaker');

// Circuit breaker configuration presets
interface CircuitBreakerConfig {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold: number;
}

const CIRCUIT_CONFIGS: Record<string, CircuitBreakerConfig> = {
  // For payment services - very conservative, fail fast
  payment: {
    timeout: 5000,           // 5 second timeout
    errorThresholdPercentage: 25, // Open circuit after 25% failures
    resetTimeout: 30000,     // Wait 30 seconds before trying again
    volumeThreshold: 5,      // Minimum 5 requests before calculating error rate
  },
  // For search/Elasticsearch - more tolerant, can degrade gracefully
  search: {
    timeout: 3000,           // 3 second timeout
    errorThresholdPercentage: 50, // Open circuit after 50% failures
    resetTimeout: 15000,     // Wait 15 seconds before trying again
    volumeThreshold: 10,     // Minimum 10 requests
  },
  // For external APIs - moderate tolerance
  external: {
    timeout: 10000,          // 10 second timeout
    errorThresholdPercentage: 40,
    resetTimeout: 20000,
    volumeThreshold: 5,
  },
  // Default configuration
  default: {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 5,
  },
};

// Store all circuit breakers for monitoring
const breakers = new Map<string, CircuitBreaker>();

interface CircuitBreakerStats {
  successes: number;
  failures: number;
  timeouts: number;
  rejects: number;
  fallbacks: number;
}

interface CircuitBreakerStatus {
  state: 'open' | 'half-open' | 'closed';
  stats: CircuitBreakerStats;
}

/**
 * Create a circuit breaker for a service
 * @param name - Service name (for metrics and logging)
 * @param action - The async function to protect
 * @param configPreset - Configuration preset name
 * @param fallbackFn - Optional fallback function when circuit is open
 * @returns Configured circuit breaker
 */
export function createCircuitBreaker<T extends unknown[], R>(
  name: string,
  action: (...args: T) => Promise<R>,
  configPreset: string = 'default',
  fallbackFn: ((...args: T) => Promise<R>) | null = null
): CircuitBreaker<T, R> {
  const config = CIRCUIT_CONFIGS[configPreset] || CIRCUIT_CONFIGS.default;

  const breaker = new CircuitBreaker<T, R>(action, {
    ...config,
    name,
  });

  // Set up event handlers for monitoring
  breaker.on('success', () => {
    logger.debug({ service: name }, 'Circuit breaker success');
  });

  breaker.on('timeout', () => {
    logger.warn({ service: name }, 'Circuit breaker timeout');
    circuitBreakerFailures.labels(name).inc();
  });

  breaker.on('reject', () => {
    logger.warn({ service: name }, 'Circuit breaker rejected (circuit open)');
  });

  breaker.on('open', () => {
    logger.error({ service: name }, 'Circuit breaker opened');
    circuitBreakerState.labels(name).set(1); // 1 = open
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name }, 'Circuit breaker half-open');
    circuitBreakerState.labels(name).set(2); // 2 = half-open
  });

  breaker.on('close', () => {
    logger.info({ service: name }, 'Circuit breaker closed');
    circuitBreakerState.labels(name).set(0); // 0 = closed
  });

  breaker.on('fallback', () => {
    logger.info({ service: name }, 'Circuit breaker fallback executed');
  });

  breaker.on('failure', (error: Error) => {
    logger.error({ service: name, error: error.message }, 'Circuit breaker failure');
    circuitBreakerFailures.labels(name).inc();
  });

  // Set fallback if provided
  if (fallbackFn) {
    breaker.fallback(fallbackFn);
  }

  // Initialize state metric
  circuitBreakerState.labels(name).set(0);

  // Store breaker for monitoring
  breakers.set(name, breaker as CircuitBreaker);

  return breaker;
}

/**
 * Get circuit breaker status for all services
 * @returns Status of all circuit breakers
 */
export function getCircuitBreakerStatus(): Record<string, CircuitBreakerStatus> {
  const status: Record<string, CircuitBreakerStatus> = {};
  for (const [name, breaker] of breakers) {
    status[name] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      stats: {
        successes: breaker.stats.successes,
        failures: breaker.stats.failures,
        timeouts: breaker.stats.timeouts,
        rejects: breaker.stats.rejects,
        fallbacks: breaker.stats.fallbacks,
      },
    };
  }
  return status;
}

/**
 * Force open a circuit breaker (for maintenance/testing)
 * @param name - Service name
 */
export function forceOpen(name: string): void {
  const breaker = breakers.get(name);
  if (breaker) {
    breaker.open();
    logger.warn({ service: name }, 'Circuit breaker force opened');
  }
}

/**
 * Force close a circuit breaker (for recovery)
 * @param name - Service name
 */
export function forceClose(name: string): void {
  const breaker = breakers.get(name);
  if (breaker) {
    breaker.close();
    logger.info({ service: name }, 'Circuit breaker force closed');
  }
}

// Pre-configured circuit breaker for search operations
interface SearchCircuitBreaker {
  breaker: CircuitBreaker | null;
  init: <T extends unknown[], R>(
    searchFn: (...args: T) => Promise<R>,
    fallbackFn: (...args: T) => Promise<R>
  ) => void;
  fire: <T extends unknown[], R>(...args: T) => Promise<R>;
}

export const searchCircuitBreaker: SearchCircuitBreaker = {
  breaker: null,

  /**
   * Initialize the search circuit breaker
   * @param searchFn - The search function to wrap
   * @param fallbackFn - Fallback when circuit is open
   */
  init<T extends unknown[], R>(
    searchFn: (...args: T) => Promise<R>,
    fallbackFn: (...args: T) => Promise<R>
  ): void {
    this.breaker = createCircuitBreaker('elasticsearch', searchFn, 'search', fallbackFn) as CircuitBreaker;
  },

  /**
   * Execute a search through the circuit breaker
   * @param args - Arguments to pass to search function
   * @returns Search results or fallback
   */
  async fire<T extends unknown[], R>(...args: T): Promise<R> {
    if (!this.breaker) {
      throw new Error('Search circuit breaker not initialized');
    }
    return this.breaker.fire(...args) as Promise<R>;
  },
};

// Pre-configured circuit breaker for payment operations
interface PaymentCircuitBreaker {
  breaker: CircuitBreaker | null;
  init: <T extends unknown[], R>(
    paymentFn: (...args: T) => Promise<R>,
    fallbackFn: (...args: T) => Promise<R>
  ) => void;
  fire: <T extends unknown[], R>(...args: T) => Promise<R>;
}

export const paymentCircuitBreaker: PaymentCircuitBreaker = {
  breaker: null,

  /**
   * Initialize the payment circuit breaker
   * @param paymentFn - The payment processing function
   * @param fallbackFn - Fallback when circuit is open
   */
  init<T extends unknown[], R>(
    paymentFn: (...args: T) => Promise<R>,
    fallbackFn: (...args: T) => Promise<R>
  ): void {
    this.breaker = createCircuitBreaker('payment', paymentFn, 'payment', fallbackFn) as CircuitBreaker;
  },

  /**
   * Execute a payment through the circuit breaker
   * @param args - Arguments to pass to payment function
   * @returns Payment result or fallback
   */
  async fire<T extends unknown[], R>(...args: T): Promise<R> {
    if (!this.breaker) {
      throw new Error('Payment circuit breaker not initialized');
    }
    return this.breaker.fire(...args) as Promise<R>;
  },
};

export default {
  createCircuitBreaker,
  getCircuitBreakerStatus,
  forceOpen,
  forceClose,
  searchCircuitBreaker,
  paymentCircuitBreaker,
  CIRCUIT_CONFIGS,
};
