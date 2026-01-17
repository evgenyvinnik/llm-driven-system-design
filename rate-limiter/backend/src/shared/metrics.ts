/**
 * @fileoverview Prometheus metrics for the rate limiter service.
 *
 * Provides comprehensive observability metrics for:
 * - Rate limit operations (allowed/denied counts)
 * - Latency distributions
 * - Circuit breaker states
 * - Redis connection health
 *
 * Metrics are exposed in Prometheus format at /metrics endpoint.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Custom registry for rate limiter metrics.
 * Using a custom registry allows for better isolation in tests
 * and prevents conflicts with other applications.
 */
export const metricsRegistry = new Registry();

// Collect Node.js default metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry, prefix: 'ratelimiter_' });

/**
 * Counter for rate limit check operations.
 * Labels:
 * - result: 'allowed' or 'denied'
 * - algorithm: the rate limiting algorithm used
 */
const rateLimitChecks = new Counter({
  name: 'ratelimiter_checks_total',
  help: 'Total number of rate limit checks performed',
  labelNames: ['result', 'algorithm'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for rate limit check latency.
 * Buckets are optimized for sub-millisecond to 100ms operations.
 */
const rateLimitLatency = new Histogram({
  name: 'ratelimiter_check_duration_seconds',
  help: 'Duration of rate limit checks in seconds',
  labelNames: ['algorithm'] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Gauge for currently active rate limit identifiers.
 * Helps monitor the memory footprint of the rate limiter.
 */
const activeIdentifiers = new Gauge({
  name: 'ratelimiter_active_identifiers',
  help: 'Number of unique identifiers currently being tracked',
  registers: [metricsRegistry],
});

/**
 * Counter for HTTP requests by status code.
 */
const httpRequests = new Counter({
  name: 'ratelimiter_http_requests_total',
  help: 'Total HTTP requests by method, path, and status',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for HTTP request duration.
 */
const httpDuration = new Histogram({
  name: 'ratelimiter_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

/**
 * Gauge for circuit breaker states.
 * Value is 1 for the current state, 0 for others.
 */
const circuitBreakerState = new Gauge({
  name: 'ratelimiter_circuit_breaker_state',
  help: 'Circuit breaker state (1 = current state)',
  labelNames: ['name', 'state'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for circuit breaker calls by outcome.
 */
const circuitBreakerCalls = new Counter({
  name: 'ratelimiter_circuit_breaker_calls_total',
  help: 'Total circuit breaker calls by outcome',
  labelNames: ['name', 'result'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge for Redis connection status.
 * 1 = connected, 0 = disconnected
 */
const redisConnected = new Gauge({
  name: 'ratelimiter_redis_connected',
  help: 'Redis connection status (1 = connected, 0 = disconnected)',
  registers: [metricsRegistry],
});

/**
 * Histogram for Redis operation latency.
 */
const redisLatency = new Histogram({
  name: 'ratelimiter_redis_operation_duration_seconds',
  help: 'Redis operation duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [metricsRegistry],
});

/**
 * Counter for Redis operations by outcome.
 */
const redisOperations = new Counter({
  name: 'ratelimiter_redis_operations_total',
  help: 'Total Redis operations by outcome',
  labelNames: ['operation', 'result'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for fallback activations.
 * Tracks when the system falls back due to Redis unavailability.
 */
const fallbackActivations = new Counter({
  name: 'ratelimiter_fallback_activations_total',
  help: 'Total number of times fallback behavior was activated',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge for rate limit remaining quota.
 * Useful for alerting when users are close to their limits.
 */
const rateLimitRemaining = new Gauge({
  name: 'ratelimiter_remaining_quota',
  help: 'Remaining quota for tracked identifiers (sampled)',
  labelNames: ['identifier_hash'] as const,
  registers: [metricsRegistry],
});

/**
 * Exported metrics object for use throughout the application.
 */
export const prometheusMetrics = {
  // Rate limit metrics
  rateLimitChecks,
  rateLimitLatency,
  activeIdentifiers,
  rateLimitRemaining,

  // HTTP metrics
  httpRequests,
  httpDuration,

  // Circuit breaker metrics
  circuitBreakerState,
  circuitBreakerCalls,

  // Redis metrics
  redisConnected,
  redisLatency,
  redisOperations,

  // Fallback metrics
  fallbackActivations,

  /**
   * Record a rate limit check result.
   *
   * @param algorithm - The algorithm used
   * @param allowed - Whether the request was allowed
   * @param durationSeconds - Time taken for the check
   */
  recordCheck(algorithm: string, allowed: boolean, durationSeconds: number) {
    rateLimitChecks.inc({ result: allowed ? 'allowed' : 'denied', algorithm });
    rateLimitLatency.observe({ algorithm }, durationSeconds);
  },

  /**
   * Record an HTTP request.
   *
   * @param method - HTTP method
   * @param path - Request path (normalized)
   * @param status - Response status code
   * @param durationSeconds - Request duration
   */
  recordHttp(method: string, path: string, status: number, durationSeconds: number) {
    httpRequests.inc({ method, path, status: status.toString() });
    httpDuration.observe({ method, path }, durationSeconds);
  },

  /**
   * Update Redis connection status.
   *
   * @param connected - Whether Redis is connected
   */
  setRedisConnected(connected: boolean) {
    redisConnected.set(connected ? 1 : 0);
  },

  /**
   * Record a Redis operation.
   *
   * @param operation - Operation name
   * @param success - Whether it succeeded
   * @param durationSeconds - Operation duration
   */
  recordRedisOperation(operation: string, success: boolean, durationSeconds: number) {
    redisOperations.inc({ operation, result: success ? 'success' : 'error' });
    redisLatency.observe({ operation }, durationSeconds);
  },

  /**
   * Record a fallback activation.
   *
   * @param reason - Why fallback was activated
   */
  recordFallback(reason: string) {
    fallbackActivations.inc({ reason });
  },

  /**
   * Update active identifier count.
   *
   * @param count - Number of active identifiers
   */
  setActiveIdentifiers(count: number) {
    activeIdentifiers.set(count);
  },
};

/**
 * Get all metrics in Prometheus text format.
 *
 * @returns Promise resolving to metrics string
 */
export async function getMetricsText(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Get metrics content type for HTTP response.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}
