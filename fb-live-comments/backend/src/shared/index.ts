/**
 * Shared Modules Index
 *
 * Re-exports all shared modules for convenient importing throughout the application.
 *
 * @module shared
 */

export { logger, createChildLogger } from './logger.js';
export {
  metricsRegistry,
  getMetrics,
  getMetricsContentType,
  // WebSocket metrics
  wsConnectionsGauge,
  wsConnectionsOpenedCounter,
  wsConnectionsClosedCounter,
  wsMessageSizeHistogram,
  // Comment metrics
  commentsPostedCounter,
  commentLatencyHistogram,
  // Reaction metrics
  reactionsPostedCounter,
  // Viewer metrics
  peakViewersGauge,
  // Database metrics
  dbQueryDurationHistogram,
  dbPoolGauge,
  // Circuit breaker metrics
  circuitBreakerStateGauge,
  circuitBreakerFailuresCounter,
  // Rate limiting metrics
  rateLimitExceededCounter,
  // Idempotency metrics
  idempotencyDuplicatesCounter,
} from './metrics.js';
export {
  createCircuitBreaker,
  createDatabaseCircuitBreaker,
  createRedisCircuitBreaker,
  type CircuitBreakerOptions,
} from './circuitBreaker.js';
export {
  checkIdempotencyKey,
  storeIdempotencyResult,
  generateIdempotencyKey,
  deleteIdempotencyKey,
  type IdempotencyResult,
} from './idempotency.js';
