/**
 * Shared modules for the Find My backend.
 *
 * This module exports all shared infrastructure components:
 * - logger: Structured logging with Pino
 * - metrics: Prometheus metrics for observability
 * - cache: Redis caching with cache-aside pattern
 * - idempotency: Duplicate request prevention
 * - rateLimit: Rate limiting middleware
 * - health: Health check endpoints
 */

// Logging
export { logger, httpLogger, createComponentLogger, logTimed } from './logger.js';

// Metrics
export {
  metricsRegistry,
  metricsMiddleware,
  metricsHandler,
  httpRequestsTotal,
  httpRequestDuration,
  locationReportsTotal,
  cacheOperations,
  activeSessions,
  registeredDevices,
  dbQueryDuration,
  redisOperationDuration,
  idempotencyDedupes,
  rateLimitHits,
} from './metrics.js';

// Caching
export {
  cacheService,
  CacheService,
  CACHE_TTL,
  CACHE_KEYS,
} from './cache.js';

// Idempotency
export {
  generateIdempotencyKey,
  checkIdempotency,
  markProcessed,
  validateTimestamp,
  idempotencyMiddleware,
  IDEMPOTENCY_TTL,
  IDEMPOTENCY_PREFIX,
} from './idempotency.js';

// Rate limiting
export {
  locationReportLimiter,
  locationQueryLimiter,
  authLimiter,
  deviceRegistrationLimiter,
  adminLimiter,
  generalLimiter,
  perUserRateLimiter,
  createRateLimiter,
} from './rateLimit.js';

// Health checks
export {
  shallowHealthCheck,
  deepHealthCheck,
  waitForDependencies,
  checkPostgres,
  checkRedis,
} from './health.js';
