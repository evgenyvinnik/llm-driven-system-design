/**
 * Shared modules index.
 *
 * Re-exports all shared modules for convenient imports:
 *
 * import { logger, metricsMiddleware, healthRoutes } from './shared/index.js';
 */

// Structured logging
export { logger, requestLoggingMiddleware, createRequestLogger, logSyncOperation, logAggregation, logDbQuery } from './logger.js';

// Prometheus metrics
export {
  register,
  httpRequestDuration,
  httpRequestTotal,
  samplesIngestedTotal,
  syncDuration,
  aggregationDuration,
  activeUsers,
  dbQueryDuration,
  dbPoolSize,
  cacheOperations,
  idempotencyOperations,
  metricsMiddleware,
  getMetrics,
  getMetricsContentType,
  createTimer,
  recordPoolMetrics
} from './metrics.js';

// Health checks
export { livenessCheck, readinessCheck, healthRoutes } from './health.js';

// Data retention
export {
  retentionConfig,
  cacheTTLConfig,
  runRetentionCleanup,
  compressOldChunks,
  replayAggregation,
  getRetentionStatus
} from './retention.js';

// Idempotency
export {
  checkIdempotency,
  storeIdempotencyKey,
  generateIdempotencyKey,
  idempotencyMiddleware,
  cleanupExpiredKeys
} from './idempotency.js';
