// @ts-expect-error - opossum lacks type declarations
import CircuitBreaker from 'opossum';
import { logger } from './logger.js';

export interface CircuitBreakerOverrides {
  timeout?: number | false;
  volumeThreshold?: number;
  /** Return true for errors that should NOT count as failures (the dependency answered). */
  errorFilter?: (err: unknown) => boolean;
}

/** Creates an Opossum circuit breaker (opens at 50% errors, half-opens after 30s) with logging on state transitions. */
export function createCircuitBreaker<T>(
  fn: (...args: unknown[]) => Promise<T>,
  name: string,
  overrides: CircuitBreakerOverrides = {},
): CircuitBreaker<unknown[], T> {
  const breaker = new CircuitBreaker(fn, {
    timeout: 10000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    name,
    ...overrides,
  });

  breaker.on('open', () => {
    logger.warn({ circuit: name }, 'Circuit breaker opened');
  });

  breaker.on('halfOpen', () => {
    logger.info({ circuit: name }, 'Circuit breaker half-open');
  });

  breaker.on('close', () => {
    logger.info({ circuit: name }, 'Circuit breaker closed');
  });

  return breaker;
}
