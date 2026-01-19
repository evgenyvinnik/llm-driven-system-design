/**
 * Circuit Breaker for external service calls
 *
 * Uses the opossum library to implement circuit breaker pattern for:
 * - CDN origin requests
 * - Transcoding service calls
 * - DRM license server
 * - External API calls
 *
 * Benefits:
 * - Prevents cascade failures when dependencies are down
 * - Provides fallback behavior for graceful degradation
 * - Auto-recovery with half-open state testing
 */
import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import {
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses
} from './metrics.js';

// State values for metrics
const STATE_CLOSED = 0;
const STATE_HALF_OPEN = 1;
const STATE_OPEN = 2;

export interface ServiceConfig {
  timeout: number;
  errorThresholdPercentage: number;
  resetTimeout: number;
  volumeThreshold: number;
  name: string;
}

export interface CircuitBreakerHealth {
  state: string;
  stats?: {
    fires: number;
    failures: number;
    successes: number;
    timeouts: number;
    rejects: number;
  };
}

export type ServiceName = 'cdn' | 'transcoding' | 'drm' | 'storage';

/**
 * Default circuit breaker options
 */
const defaultOptions: Omit<ServiceConfig, 'name'> = {
  timeout: 10000, // 10 seconds
  errorThresholdPercentage: 50, // Open circuit after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5 // Minimum requests before checking error percentage
};

/**
 * Service-specific configurations
 */
export const serviceConfigs: Record<ServiceName, ServiceConfig> = {
  cdn: {
    timeout: 5000,
    errorThresholdPercentage: 30,
    resetTimeout: 15000,
    volumeThreshold: 10,
    name: 'cdn'
  },
  transcoding: {
    timeout: 300000, // 5 minutes for transcoding
    errorThresholdPercentage: 50,
    resetTimeout: 120000, // 2 minutes
    volumeThreshold: 3,
    name: 'transcoding'
  },
  drm: {
    timeout: 5000,
    errorThresholdPercentage: 25,
    resetTimeout: 60000,
    volumeThreshold: 5,
    name: 'drm'
  },
  storage: {
    timeout: 10000,
    errorThresholdPercentage: 40,
    resetTimeout: 30000,
    volumeThreshold: 5,
    name: 'storage'
  }
};

type AsyncFunction<T> = () => Promise<T>;

/**
 * Create a circuit breaker for a service
 * @param action - The async function to wrap
 * @param serviceName - Name of the service (cdn, transcoding, drm, storage)
 * @param fallback - Optional fallback function when circuit is open
 * @returns Configured circuit breaker
 */
export function createCircuitBreaker<T>(
  action: (fn: AsyncFunction<T>) => Promise<T>,
  serviceName: string,
  fallback: (() => Promise<T>) | null = null
): CircuitBreaker<[AsyncFunction<T>], T> {
  const config = serviceConfigs[serviceName as ServiceName] || { ...defaultOptions, name: serviceName };

  const breaker = new CircuitBreaker<[AsyncFunction<T>], T>(action, {
    ...config,
    name: config.name
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', () => {
    circuitBreakerSuccesses.inc({ service: serviceName });
  });

  breaker.on('failure', (error: Error) => {
    circuitBreakerFailures.inc({ service: serviceName });
    logger.warn({
      service: serviceName,
      error: error.message
    }, 'Circuit breaker recorded failure');
  });

  breaker.on('open', () => {
    circuitBreakerState.set({ service: serviceName }, STATE_OPEN);
    logger.error({
      service: serviceName
    }, 'Circuit breaker OPENED - service calls will fail fast');
  });

  breaker.on('halfOpen', () => {
    circuitBreakerState.set({ service: serviceName }, STATE_HALF_OPEN);
    logger.info({
      service: serviceName
    }, 'Circuit breaker HALF-OPEN - testing service');
  });

  breaker.on('close', () => {
    circuitBreakerState.set({ service: serviceName }, STATE_CLOSED);
    logger.info({
      service: serviceName
    }, 'Circuit breaker CLOSED - service recovered');
  });

  breaker.on('timeout', () => {
    logger.warn({
      service: serviceName,
      timeout: config.timeout
    }, 'Circuit breaker request timed out');
  });

  breaker.on('reject', () => {
    logger.warn({
      service: serviceName
    }, 'Circuit breaker rejected request (circuit open)');
  });

  // Set up fallback if provided
  if (fallback) {
    breaker.fallback(fallback);
  }

  // Initialize state metric
  circuitBreakerState.set({ service: serviceName }, STATE_CLOSED);

  return breaker;
}

/**
 * CDN Circuit Breaker wrapper
 * Used for fetching content from CDN origin
 */
let cdnBreaker: CircuitBreaker<[AsyncFunction<unknown>], unknown> | null = null;

export function getCdnBreaker(): CircuitBreaker<[AsyncFunction<unknown>], unknown> {
  if (!cdnBreaker) {
    cdnBreaker = createCircuitBreaker(
      async (fetchFn: AsyncFunction<unknown>) => fetchFn(),
      'cdn',
      async () => {
        logger.info('CDN circuit open - using cached content or alternative');
        return { fallback: true, message: 'CDN temporarily unavailable' };
      }
    );
  }
  return cdnBreaker;
}

/**
 * Transcoding Circuit Breaker wrapper
 * Used for submitting and monitoring transcoding jobs
 */
let transcodingBreaker: CircuitBreaker<[AsyncFunction<unknown>], unknown> | null = null;

export function getTranscodingBreaker(): CircuitBreaker<[AsyncFunction<unknown>], unknown> {
  if (!transcodingBreaker) {
    transcodingBreaker = createCircuitBreaker(
      async (jobFn: AsyncFunction<unknown>) => jobFn(),
      'transcoding',
      async () => {
        logger.info('Transcoding circuit open - queuing job for later');
        return { fallback: true, queued: true };
      }
    );
  }
  return transcodingBreaker;
}

/**
 * DRM Circuit Breaker wrapper
 * Used for license issuance
 */
let drmBreaker: CircuitBreaker<[AsyncFunction<unknown>], unknown> | null = null;

export function getDrmBreaker(): CircuitBreaker<[AsyncFunction<unknown>], unknown> {
  if (!drmBreaker) {
    drmBreaker = createCircuitBreaker(
      async (licenseFn: AsyncFunction<unknown>) => licenseFn(),
      'drm',
      async () => {
        throw new Error('DRM service unavailable - cannot issue license');
      }
    );
  }
  return drmBreaker;
}

/**
 * Storage Circuit Breaker wrapper
 * Used for MinIO/S3 operations
 */
let storageBreaker: CircuitBreaker<[AsyncFunction<unknown>], unknown> | null = null;

export function getStorageBreaker(): CircuitBreaker<[AsyncFunction<unknown>], unknown> {
  if (!storageBreaker) {
    storageBreaker = createCircuitBreaker(
      async (storageFn: AsyncFunction<unknown>) => storageFn(),
      'storage',
      async () => {
        logger.info('Storage circuit open - using cached data');
        return { fallback: true, cached: true };
      }
    );
  }
  return storageBreaker;
}

/**
 * Execute a function with circuit breaker protection
 * @param serviceName - Service name (cdn, transcoding, drm, storage)
 * @param fn - Async function to execute
 * @returns Result of the function or fallback
 */
export async function withCircuitBreaker<T>(
  serviceName: string,
  fn: AsyncFunction<T>
): Promise<T> {
  let breaker: CircuitBreaker<[AsyncFunction<unknown>], unknown>;
  switch (serviceName) {
    case 'cdn':
      breaker = getCdnBreaker();
      break;
    case 'transcoding':
      breaker = getTranscodingBreaker();
      break;
    case 'drm':
      breaker = getDrmBreaker();
      break;
    case 'storage':
      breaker = getStorageBreaker();
      break;
    default:
      // For unknown services, execute without circuit breaker
      return fn();
  }

  return breaker.fire(fn as AsyncFunction<unknown>) as Promise<T>;
}

/**
 * Get circuit breaker health status for all services
 * @returns Health status of all circuit breakers
 */
export function getCircuitBreakerHealth(): Record<string, CircuitBreakerHealth> {
  const breakers: Record<string, CircuitBreaker<[AsyncFunction<unknown>], unknown> | null> = {
    cdn: cdnBreaker,
    transcoding: transcodingBreaker,
    drm: drmBreaker,
    storage: storageBreaker
  };

  const health: Record<string, CircuitBreakerHealth> = {};
  for (const [name, breaker] of Object.entries(breakers)) {
    if (breaker) {
      health[name] = {
        state: breaker.opened ? 'open' : (breaker.halfOpen ? 'half-open' : 'closed'),
        stats: {
          fires: breaker.stats.fires,
          failures: breaker.stats.failures,
          successes: breaker.stats.successes,
          timeouts: breaker.stats.timeouts,
          rejects: breaker.stats.rejects
        }
      };
    } else {
      health[name] = { state: 'not-initialized' };
    }
  }

  return health;
}
