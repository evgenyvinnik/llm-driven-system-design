/**
 * Shared modules index
 *
 * This file exports all shared infrastructure modules for easy importing.
 * Each module addresses specific Codex feedback:
 *
 * - logger: Structured logging with pino for observability
 * - metrics: Prometheus metrics for monitoring and alerting
 * - cache: Redis caching for reduced database load
 * - circuitBreaker: Failure isolation for storage operations
 * - idempotency: Safe retry handling for sync operations
 * - health: Comprehensive health checks for load balancers
 */

export { default as logger, createChildLogger, requestLogger, auditLogger, logAuditEvent } from './logger.js';

export {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  syncDuration,
  syncOperationsTotal,
  conflictsTotal,
  chunkOperationDuration,
  dedupHitsTotal,
  bytesUploaded,
  bytesDownloaded,
  cacheHits,
  cacheMisses,
  circuitBreakerState,
  circuitBreakerFailures,
  websocketConnections,
  metricsMiddleware,
  metricsHandler,
  startTimer,
} from './metrics.js';

export {
  TTL,
  CacheAside,
  FileMetadataCache,
  StorageQuotaCache,
  ChunkExistsCache,
  SyncStateCache,
  createCaches,
} from './cache.js';

export {
  createCircuitBreaker,
  StorageCircuitBreakers,
  createDatabaseCircuitBreaker,
} from './circuitBreaker.js';

export {
  createIdempotencyMiddleware,
  IdempotencyHandler,
  withIdempotency,
  generateIdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from './idempotency.js';

export { HealthChecker, createHealthRoutes } from './health.js';
