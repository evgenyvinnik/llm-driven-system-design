/**
 * Circuit Breaker Pattern Implementation
 *
 * WHY: Circuit breakers prevent cascading failures by:
 * - Failing fast when downstream services are unhealthy
 * - Giving downstream services time to recover
 * - Providing fallback behavior for degraded operation
 * - Protecting against thundering herd on recovery
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger.js';
import * as metrics from './metrics.js';

// Default circuit breaker options
export const DEFAULT_OPTIONS: CircuitBreaker.Options = {
  timeout: 5000, // 5 seconds
  errorThresholdPercentage: 50, // Open circuit after 50% failures
  resetTimeout: 30000, // Try again after 30 seconds
  volumeThreshold: 5, // Minimum requests before tripping
};

// Circuit breaker state mapping for metrics
const STATE_MAP: Record<string, number> = {
  closed: 0,
  halfOpen: 1,
  open: 2,
};

export interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
}

export interface PaymentFallbackResult {
  success: boolean;
  queued: boolean;
  message: string;
}

export interface AvailabilityFallbackResult {
  available: boolean;
  fallback: boolean;
  message: string;
}

/**
 * Create a circuit breaker for a service
 * @param name - Service name for logging and metrics
 * @param fn - The function to wrap
 * @param options - Circuit breaker options
 * @param fallback - Optional fallback function
 * @returns CircuitBreaker instance
 */
export function createCircuitBreaker<T extends (...args: unknown[]) => unknown>(
  name: string,
  fn: T,
  options: CircuitBreakerOptions = {},
  fallback: ((...args: Parameters<T>) => ReturnType<T>) | null = null
): CircuitBreaker<Parameters<T>, ReturnType<T>> {
  const breaker = new CircuitBreaker<Parameters<T>, ReturnType<T>>(fn, {
    ...DEFAULT_OPTIONS,
    ...options,
    name,
  });

  // Set up event handlers for logging and metrics
  breaker.on('success', () => {
    logger.debug({ service: name }, 'Circuit breaker call succeeded');
  });

  breaker.on('timeout', () => {
    logger.warn({ service: name }, 'Circuit breaker call timed out');
    metrics.circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('reject', () => {
    logger.warn({ service: name }, 'Circuit breaker rejected call (circuit open)');
    metrics.circuitBreakerFailuresTotal.inc({ service: name });
  });

  breaker.on('open', () => {
    logger.error({ service: name }, 'Circuit breaker opened');
    metrics.circuitBreakerState.set({ service: name }, STATE_MAP.open ?? 2);
  });

  breaker.on('halfOpen', () => {
    logger.info({ service: name }, 'Circuit breaker half-opened');
    metrics.circuitBreakerState.set({ service: name }, STATE_MAP.halfOpen ?? 1);
  });

  breaker.on('close', () => {
    logger.info({ service: name }, 'Circuit breaker closed');
    metrics.circuitBreakerState.set({ service: name }, STATE_MAP.closed ?? 0);
  });

  breaker.on('fallback', () => {
    logger.info({ service: name }, 'Circuit breaker fallback executed');
  });

  // Initialize state metric
  metrics.circuitBreakerState.set({ service: name }, STATE_MAP.closed ?? 0);

  // Set fallback if provided
  if (fallback) {
    breaker.fallback(fallback as (...args: unknown[]) => unknown);
  }

  return breaker;
}

/**
 * Wrap an async function with circuit breaker
 * @param name - Service name
 * @param fn - Async function to wrap
 * @param options - Options
 * @returns Wrapped function
 */
export function withCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  name: string,
  fn: T,
  options: CircuitBreakerOptions = {}
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
  const breaker = createCircuitBreaker(name, fn, options);

  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return breaker.fire(...args) as ReturnType<T>;
  };
}

// ============================================
// Pre-configured Circuit Breakers for Services
// ============================================

/**
 * Payment service circuit breaker
 * More conservative settings due to financial impact
 */
const paymentCircuitBreakerOptions: CircuitBreakerOptions = {
  timeout: 10000, // 10 seconds - payments can be slow
  errorThresholdPercentage: 30, // Open at 30% failures
  resetTimeout: 60000, // Wait 60 seconds before retry
  volumeThreshold: 3, // Trip after 3 failed requests
};

type PaymentFunction = (bookingId: string, amount: number) => Promise<unknown>;

/**
 * Create a payment service circuit breaker
 */
export function createPaymentCircuitBreaker(
  paymentFn: PaymentFunction
): CircuitBreaker<[string, number], unknown> {
  return createCircuitBreaker(
    'payment-service',
    paymentFn,
    paymentCircuitBreakerOptions,
    // Fallback: queue payment for later processing
    async (bookingId: string, amount: number): Promise<PaymentFallbackResult> => {
      logger.warn(
        { bookingId, amount },
        'Payment service unavailable, queueing for later'
      );
      return {
        success: false,
        queued: true,
        message: 'Payment queued for processing',
      };
    }
  );
}

/**
 * Availability service circuit breaker
 * Used for external availability APIs if integrated
 */
const availabilityCircuitBreakerOptions: CircuitBreakerOptions = {
  timeout: 3000, // 3 seconds
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

type AvailabilityFunction = (
  hotelId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string
) => Promise<unknown>;

/**
 * Create an availability check circuit breaker
 */
export function createAvailabilityCircuitBreaker(
  availabilityFn: AvailabilityFunction
): CircuitBreaker<[string, string, string, string], unknown> {
  return createCircuitBreaker(
    'availability-service',
    availabilityFn,
    availabilityCircuitBreakerOptions,
    // Fallback: return cached or pessimistic response
    async (
      hotelId: string,
      roomTypeId: string,
      checkIn: string,
      checkOut: string
    ): Promise<AvailabilityFallbackResult> => {
      logger.warn(
        { hotelId, roomTypeId, checkIn, checkOut },
        'Availability service unavailable, returning unavailable'
      );
      return {
        available: false,
        fallback: true,
        message: 'Unable to check availability, please try again',
      };
    }
  );
}

/**
 * Elasticsearch circuit breaker
 */
const elasticsearchCircuitBreakerOptions: CircuitBreakerOptions = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 20000,
  volumeThreshold: 5,
};

type SearchFunction = (...args: unknown[]) => Promise<unknown>;

/**
 * Create an Elasticsearch circuit breaker
 */
export function createElasticsearchCircuitBreaker(
  searchFn: SearchFunction,
  fallbackFn: SearchFunction | null = null
): CircuitBreaker<unknown[], unknown> {
  return createCircuitBreaker(
    'elasticsearch',
    searchFn,
    elasticsearchCircuitBreakerOptions,
    fallbackFn
  );
}

export default {
  createCircuitBreaker,
  withCircuitBreaker,
  createPaymentCircuitBreaker,
  createAvailabilityCircuitBreaker,
  createElasticsearchCircuitBreaker,
  DEFAULT_OPTIONS,
};
