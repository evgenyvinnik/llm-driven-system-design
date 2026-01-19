/**
 * Shared modules index
 *
 * Exports all shared modules for easy importing:
 * - Logger: Structured logging with pino
 * - Metrics: Prometheus metrics for observability
 * - Circuit Breaker: Resilience patterns for external calls
 * - Idempotency: Safe request retries
 */

export {
  logger,
  auditLogger,
  auditLog,
  AuditEvents,
  requestLoggerMiddleware
} from './logger.js';

export type { AuditLogData, AuditEventType } from './logger.js';

export {
  register,
  metricsMiddleware,
  metricsHandler,
  httpRequestDuration,
  httpRequestTotal,
  playbackStartLatency,
  activeStreams,
  manifestGenerationDuration,
  segmentRequestsTotal,
  streamingErrors,
  cdnCacheHits,
  cdnCacheMisses,
  drmLicenseRequests,
  drmLicenseLatency,
  transcodingJobDuration,
  transcodingJobsTotal,
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
  watchProgressUpdates,
  idempotentRequestsTotal
} from './metrics.js';

export {
  withCircuitBreaker,
  getCircuitBreakerHealth,
  createCircuitBreaker,
  serviceConfigs
} from './circuitBreaker.js';

export type { ServiceConfig, CircuitBreakerHealth, ServiceName } from './circuitBreaker.js';

export {
  idempotencyMiddleware,
  watchProgressIdempotency,
  completeWatchProgressIdempotency,
  createIdempotencyKey,
  checkIdempotency,
  markIdempotent,
  IDEMPOTENCY_TTL,
  LOCK_TTL
} from './idempotency.js';

export type { WatchProgressMeta, CachedResponse } from './idempotency.js';
