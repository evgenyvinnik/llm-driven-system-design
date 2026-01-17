/**
 * Circuit Breaker Module using Opossum.
 *
 * Implements the circuit breaker pattern to prevent cascade failures
 * in microservices architecture. When an external service fails repeatedly,
 * the circuit "opens" and immediately returns errors without attempting
 * the call, giving the failing service time to recover.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests fail fast without calling the service
 * - HALF_OPEN: Testing if service has recovered, allows limited requests
 *
 * This prevents:
 * - Resource exhaustion from waiting on failing services
 * - Cascade failures across dependent microservices
 * - Overwhelming a recovering service with requests
 */
import CircuitBreaker from 'opossum';
import { circuitBreakerLogger } from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
} from './metrics.js';

/**
 * Circuit breaker configuration options.
 */
export interface CircuitBreakerOptions {
  /** Failure percentage threshold to open circuit (default: 50) */
  errorThresholdPercentage?: number;
  /** Time in ms before attempting to close an open circuit (default: 30000) */
  resetTimeout?: number;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
  /** Number of requests to track for error percentage (default: 10) */
  volumeThreshold?: number;
  /** Whether to enable the circuit breaker (default: true) */
  enabled?: boolean;
}

/**
 * Default circuit breaker options.
 */
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  timeout: 10000,
  volumeThreshold: 10,
  enabled: true,
};

/**
 * Map of circuit breakers by service name.
 * Ensures a single circuit breaker instance per service.
 */
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * State mapping for metrics.
 */
const stateToNumber: Record<string, number> = {
  closed: 0,
  halfOpen: 1,
  open: 2,
};

/**
 * Creates or retrieves a circuit breaker for a service.
 *
 * @param serviceName - Unique identifier for the service
 * @param action - The async function to wrap with circuit breaker
 * @param options - Circuit breaker configuration
 * @returns Circuit breaker instance
 *
 * @example
 * const cassandraCB = createCircuitBreaker(
 *   'cassandra',
 *   () => cassandraClient.execute('SELECT * FROM table'),
 *   { timeout: 5000 }
 * );
 * const result = await cassandraCB.fire();
 */
export function createCircuitBreaker<T>(
  serviceName: string,
  action: (...args: unknown[]) => Promise<T>,
  options: CircuitBreakerOptions = {}
): CircuitBreaker<unknown[], T> {
  // Check if circuit breaker already exists
  const existing = circuitBreakers.get(serviceName);
  if (existing) {
    return existing as CircuitBreaker<unknown[], T>;
  }

  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker(action, {
    errorThresholdPercentage: mergedOptions.errorThresholdPercentage,
    resetTimeout: mergedOptions.resetTimeout,
    timeout: mergedOptions.timeout,
    volumeThreshold: mergedOptions.volumeThreshold,
    enabled: mergedOptions.enabled,
    name: serviceName,
  });

  // Set up event listeners for logging and metrics
  breaker.on('open', () => {
    circuitBreakerLogger.warn({ service: serviceName }, 'Circuit breaker OPENED - service is failing');
    circuitBreakerState.labels(serviceName).set(stateToNumber['open']);
  });

  breaker.on('halfOpen', () => {
    circuitBreakerLogger.info({ service: serviceName }, 'Circuit breaker HALF_OPEN - testing recovery');
    circuitBreakerState.labels(serviceName).set(stateToNumber['halfOpen']);
  });

  breaker.on('close', () => {
    circuitBreakerLogger.info({ service: serviceName }, 'Circuit breaker CLOSED - service recovered');
    circuitBreakerState.labels(serviceName).set(stateToNumber['closed']);
  });

  breaker.on('success', () => {
    circuitBreakerSuccesses.labels(serviceName).inc();
  });

  breaker.on('failure', (error) => {
    circuitBreakerFailures.labels(serviceName).inc();
    circuitBreakerLogger.error({ service: serviceName, error: String(error) }, 'Circuit breaker recorded failure');
  });

  breaker.on('timeout', () => {
    circuitBreakerLogger.warn({ service: serviceName }, 'Circuit breaker request timed out');
  });

  breaker.on('reject', () => {
    circuitBreakerLogger.warn({ service: serviceName }, 'Circuit breaker rejected request - circuit is OPEN');
  });

  // Initialize state metric
  circuitBreakerState.labels(serviceName).set(0);

  // Store for reuse
  circuitBreakers.set(serviceName, breaker as CircuitBreaker);

  return breaker;
}

/**
 * Gets the current state of a circuit breaker.
 *
 * @param serviceName - Name of the service
 * @returns Current state or undefined if not found
 */
export function getCircuitBreakerState(serviceName: string): 'closed' | 'halfOpen' | 'open' | undefined {
  const breaker = circuitBreakers.get(serviceName);
  if (!breaker) return undefined;

  if (breaker.opened) return 'open';
  if (breaker.halfOpen) return 'halfOpen';
  return 'closed';
}

/**
 * Gets statistics for a circuit breaker.
 *
 * @param serviceName - Name of the service
 * @returns Circuit breaker statistics
 */
export function getCircuitBreakerStats(serviceName: string) {
  const breaker = circuitBreakers.get(serviceName);
  if (!breaker) return null;

  return {
    state: getCircuitBreakerState(serviceName),
    stats: breaker.stats,
    enabled: breaker.enabled,
  };
}

/**
 * Gets statistics for all circuit breakers.
 */
export function getAllCircuitBreakerStats(): Record<string, ReturnType<typeof getCircuitBreakerStats>> {
  const stats: Record<string, ReturnType<typeof getCircuitBreakerStats>> = {};
  for (const [name] of circuitBreakers) {
    stats[name] = getCircuitBreakerStats(name);
  }
  return stats;
}

// =========================================================
// Pre-configured Circuit Breakers for Common Services
// =========================================================

/**
 * Circuit breaker for Cassandra/database operations.
 * Configured with shorter timeout for database operations.
 */
export function withCassandraCircuitBreaker<T>(
  operation: () => Promise<T>
): Promise<T> {
  const breaker = createCircuitBreaker<T>(
    'cassandra',
    operation,
    {
      timeout: 5000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
      volumeThreshold: 5,
    }
  );
  return breaker.fire() as Promise<T>;
}

/**
 * Circuit breaker for external CDN operations.
 * Configured with longer timeout for network operations.
 */
export function withCDNCircuitBreaker<T>(
  operation: () => Promise<T>
): Promise<T> {
  const breaker = createCircuitBreaker<T>(
    'cdn',
    operation,
    {
      timeout: 10000,
      errorThresholdPercentage: 40,
      resetTimeout: 60000,
      volumeThreshold: 10,
    }
  );
  return breaker.fire() as Promise<T>;
}

/**
 * Circuit breaker for MinIO/S3 storage operations.
 */
export function withStorageCircuitBreaker<T>(
  operation: () => Promise<T>
): Promise<T> {
  const breaker = createCircuitBreaker<T>(
    'storage',
    operation,
    {
      timeout: 8000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
      volumeThreshold: 5,
    }
  );
  return breaker.fire() as Promise<T>;
}

/**
 * Circuit breaker for Redis operations.
 */
export function withRedisCircuitBreaker<T>(
  operation: () => Promise<T>
): Promise<T> {
  const breaker = createCircuitBreaker<T>(
    'redis',
    operation,
    {
      timeout: 2000,
      errorThresholdPercentage: 50,
      resetTimeout: 15000,
      volumeThreshold: 5,
    }
  );
  return breaker.fire() as Promise<T>;
}

/**
 * Fallback handler that provides graceful degradation.
 * Returns a fallback value when the circuit is open.
 *
 * @param operation - The primary operation to attempt
 * @param fallback - The fallback value or function to call
 * @param serviceName - Name for the circuit breaker
 * @returns Promise resolving to the operation result or fallback
 */
export async function withFallback<T>(
  operation: () => Promise<T>,
  fallback: T | (() => T | Promise<T>),
  serviceName: string
): Promise<T> {
  const breaker = createCircuitBreaker<T>(serviceName, operation);

  // Set up fallback
  breaker.fallback(() => {
    if (typeof fallback === 'function') {
      return (fallback as () => T | Promise<T>)();
    }
    return fallback;
  });

  return breaker.fire() as Promise<T>;
}
