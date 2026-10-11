// @ts-expect-error - opossum lacks type declarations
import CircuitBreaker from 'opossum';
import { logger } from './logger.js';

/** Options forwarded to Opossum on top of the defaults below. */
export interface BreakerOverrides {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  /** Minimum calls in the rolling window before the error percentage can open the circuit. */
  volumeThreshold?: number;
  /** Return true for errors that are answers (e.g. "not found"), not dependency failures. */
  errorFilter?: (err: unknown) => boolean;
}

/** Creates an Opossum circuit breaker wrapping an async function with logging on state changes. */
export function createCircuitBreaker<T>(
  fn: (...args: unknown[]) => Promise<T>,
  name: string,
  overrides: BreakerOverrides = {},
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
