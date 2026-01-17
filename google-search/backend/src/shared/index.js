/**
 * Shared modules for observability, resilience, and performance
 *
 * These modules implement cross-cutting concerns:
 * - Structured logging (pino)
 * - Prometheus metrics
 * - Circuit breakers (opossum)
 * - Rate limiting (express-rate-limit + Redis)
 * - Idempotency for index operations
 * - Health checks
 */

export * from './logger.js';
export * from './metrics.js';
export * from './circuitBreaker.js';
export * from './rateLimiter.js';
export * from './idempotency.js';
export * from './health.js';
