/**
 * Shared module exports for the Figma backend.
 * Centralizes access to logging, metrics, circuit breakers, retry logic,
 * idempotency, and retention utilities.
 */

export { logger, createChildLogger } from './logger.js';
export {
  metricsRegistry,
  getMetrics,
  getMetricsContentType,
  activeCollaboratorsGauge,
  totalConnectionsGauge,
  operationsCounter,
  operationLatencyHistogram,
  syncLatencyHistogram,
  idempotencyCounter,
  circuitBreakerCounter,
  circuitBreakerStateGauge,
  retryCounter,
  dbLatencyHistogram,
  fileVersionsGauge,
  cleanupJobCounter,
} from './metrics.js';
export {
  createCircuitBreaker,
  registerCircuitBreaker,
  getCircuitBreakerHealth,
  isCircuitHealthy,
  postgresConfig,
  redisConfig,
  syncConfig,
  type CircuitBreakerConfig,
} from './circuitBreaker.js';
export {
  withRetry,
  makeRetryable,
  dbRetryOptions,
  redisRetryOptions,
  syncRetryOptions,
  type RetryOptions,
} from './retry.js';
export {
  checkIdempotency,
  storeIdempotencyResult,
  clearIdempotency,
  withIdempotency,
  generateFileOperationKey,
  type IdempotencyConfig,
  type IdempotencyResult,
} from './idempotency.js';
export {
  getRetentionConfig,
  setRetentionConfig,
  cleanupOldAutoSaves,
  cleanupOldOperations,
  cleanupSoftDeletedFiles,
  runAllCleanupTasks,
  scheduleCleanupTasks,
  updateVersionMetrics,
  defaultRetentionConfig,
  type RetentionConfig,
} from './retention.js';
