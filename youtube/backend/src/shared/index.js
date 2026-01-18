/**
 * Shared Modules Index
 *
 * Central export point for all shared infrastructure modules.
 */

// Structured logging
export { default as logger, requestLogger, createChildLogger, logEvent } from './logger.js';

// Prometheus metrics
export {
  metricsHandler,
  metricsMiddleware,
  httpRequestsTotal,
  httpRequestDuration,
  videoViewsTotal,
  videoWatchDuration,
  videoUploadsTotal,
  videoUploadSize,
  transcodeQueueDepth,
  transcodeJobDuration,
  transcodedVideosTotal,
  commentsTotal,
  reactionsTotal,
  subscriptionsTotal,
  dbQueryDuration,
  dbConnectionPoolSize,
  cacheHitRatio,
  cacheOperationsTotal,
  storageOperationsTotal,
  storageOperationDuration,
  circuitBreakerState,
  circuitBreakerFailuresTotal,
  rateLimitHitsTotal,
  register,
} from './metrics.js';

// Circuit breaker
export {
  createCircuitBreaker,
  withCircuitBreaker,
  getCircuitBreakerHealth,
  hasOpenCircuit,
  getCircuitBreaker,
} from './circuitBreaker.js';

// Rate limiting
export { rateLimit, strictRateLimit, getRateLimitStatus } from './rateLimiter.js';

// Retry logic
export {
  retry,
  withRetry,
  withRetryPreset,
  retryWithFallback,
  RETRY_PRESETS,
  RETRYABLE_ERROR_CODES,
  createRetryableErrorChecker,
} from './retry.js';

// Health checks
export { livenessHandler, readinessHandler, detailedHealthHandler } from './health.js';

// Resilient storage (with circuit breaker and retry)
export {
  uploadObject,
  getObject,
  deleteObject,
  objectExists,
  createMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  getPresignedUploadUrl,
  getPresignedDownloadUrl,
  getPublicUrl,
} from './resilientStorage.js';

// RabbitMQ queue
export {
  connectQueue,
  publishTranscodeJob,
  consumeTranscodeJobs,
  closeQueue,
  getQueueStats,
} from './queue.js';
