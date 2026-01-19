import CircuitBreaker from 'opossum';
import { createModuleLogger } from './logger.js';
import { metrics } from './metrics.js';

const logger = createModuleLogger('circuit-breaker');

// Circuit breaker state mapping for metrics
const STATE_MAP: Record<string, number> = {
  'closed': 0,
  'halfOpen': 1,
  'open': 2
};

export interface ExecutionOptions {
  image: string;
  workDir: string;
  codeFile: string;
  command: string[];
  timeout: number;
  memoryMb: number;
  language: string;
}

export interface ExecutionResult {
  status: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number;
  executionTime?: number;
  isCircuitBreakerOpen?: boolean;
}

type ExecuteFn = (options: ExecutionOptions) => Promise<ExecutionResult>;

/**
 * Create a circuit breaker for code execution
 *
 * The circuit breaker protects the system from cascading failures when the
 * Docker sandbox is unavailable or experiencing issues.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, all requests fail fast
 * - HALF-OPEN: After timeout, allow one request to test if service recovered
 */
export function createExecutionCircuitBreaker(executeFn: ExecuteFn): CircuitBreaker<[ExecutionOptions], ExecutionResult> {
  const breaker = new CircuitBreaker(executeFn, {
    // Open circuit after 5 consecutive failures
    errorThresholdPercentage: 50,
    // Minimum 5 requests before percentage is calculated
    volumeThreshold: 5,
    // Wait 30 seconds before trying again when open
    resetTimeout: 30000,
    // Request timeout (this is a fallback, actual timeout handled in executor)
    timeout: 60000,
    // Allow 3 concurrent requests during half-open state
    allowWarmUp: true,
    // Cache the response
    cache: false,
    // Rolling window for statistics
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    // Name for logging and metrics
    name: 'code-executor'
  });

  // Update metrics on state change
  breaker.on('open', () => {
    logger.warn({ state: 'open' }, 'Circuit breaker opened - code execution temporarily unavailable');
    metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.open);
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'open' });
  });

  breaker.on('halfOpen', () => {
    logger.info({ state: 'halfOpen' }, 'Circuit breaker half-open - testing if service recovered');
    metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.halfOpen);
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'halfOpen' });
  });

  breaker.on('close', () => {
    logger.info({ state: 'closed' }, 'Circuit breaker closed - code execution service recovered');
    metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.closed);
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'close' });
  });

  breaker.on('fallback', () => {
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'fallback' });
  });

  breaker.on('success', () => {
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'success' });
  });

  breaker.on('failure', (error: Error) => {
    logger.error({ error: error.message }, 'Circuit breaker recorded failure');
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'failure' });
  });

  breaker.on('reject', () => {
    logger.warn('Request rejected - circuit breaker is open');
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'reject' });
  });

  breaker.on('timeout', () => {
    metrics.circuitBreakerEvents.inc({ name: 'code-executor', event: 'timeout' });
  });

  // Initialize metrics
  metrics.circuitBreakerState.set({ name: 'code-executor' }, STATE_MAP.closed);

  return breaker;
}

/**
 * Error thrown when circuit breaker is open
 */
export class CircuitBreakerOpenError extends Error {
  statusCode: number;
  retryAfter: number;

  constructor(message = 'Code execution temporarily unavailable') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.statusCode = 503;
    this.retryAfter = 30; // seconds
  }
}

/**
 * Fallback function when circuit breaker is open
 */
export function createFallback(): () => ExecutionResult {
  return () => {
    return {
      status: 'system_error',
      error: 'Code execution temporarily unavailable. Please try again later.',
      executionTime: 0,
      isCircuitBreakerOpen: true
    };
  };
}
