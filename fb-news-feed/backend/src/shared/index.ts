/**
 * @fileoverview Shared modules index file.
 * Re-exports all shared utilities for convenient importing.
 */

// Logger
export { logger, createChildLogger, createRequestLogger, componentLoggers } from './logger.js';

// Metrics
export {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  postsCreatedTotal,
  postLikesTotal,
  commentsCreatedTotal,
  feedGenerationDuration,
  feedRequestsTotal,
  feedPostsCount,
  fanoutOperationsTotal,
  fanoutFollowersCount,
  fanoutDuration,
  cacheOperationsTotal,
  dbQueryDuration,
  wsActiveConnections,
  wsMessagesTotal,
  authAttemptsTotal,
  circuitBreakerState,
  circuitBreakerStateChanges,
  componentHealth,
  healthCheckLatency,
} from './metrics.js';

// Circuit Breaker
export { createCircuitBreaker, BREAKER_PRESETS, getCircuitBreakerStats } from './circuit-breaker.js';

// Cache
export {
  CACHE_KEYS,
  CACHE_TTL,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheGetMany,
  getFeedFromCache,
  setFeedCache,
  invalidateFeedCache,
  getIdempotencyResponse,
  setIdempotencyResponse,
} from './cache.js';

// Idempotency
export { idempotencyMiddleware, requireIdempotency, IDEMPOTENCY_HEADER } from './idempotency.js';

// Health
export { default as healthRouter } from './health.js';
