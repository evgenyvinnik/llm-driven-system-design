/**
 * Shared module exports
 *
 * Provides centralized access to all shared utilities:
 * - Logging
 * - Metrics
 * - Circuit Breaker
 * - Distributed Locking
 * - Idempotency
 * - Health Checks
 */

const logger = require('./logger');
const metrics = require('./metrics');
const circuitBreaker = require('./circuitBreaker');
const distributedLock = require('./distributedLock');
const idempotency = require('./idempotency');
const healthCheck = require('./healthCheck');

module.exports = {
  // Logger
  logger: logger.logger,
  createRequestLogger: logger.createRequestLogger,
  getTraceId: logger.getTraceId,
  requestLoggerMiddleware: logger.requestLoggerMiddleware,

  // Metrics
  metrics,
  metricsMiddleware: metrics.metricsMiddleware,
  getMetrics: metrics.getMetrics,
  getContentType: metrics.getContentType,

  // Circuit Breaker
  createCircuitBreaker: circuitBreaker.createCircuitBreaker,
  withCircuitBreaker: circuitBreaker.withCircuitBreaker,
  createPaymentCircuitBreaker: circuitBreaker.createPaymentCircuitBreaker,
  createAvailabilityCircuitBreaker: circuitBreaker.createAvailabilityCircuitBreaker,
  createElasticsearchCircuitBreaker: circuitBreaker.createElasticsearchCircuitBreaker,

  // Distributed Lock
  acquireLock: distributedLock.acquireLock,
  releaseLock: distributedLock.releaseLock,
  withLock: distributedLock.withLock,
  createRoomLockResource: distributedLock.createRoomLockResource,

  // Idempotency
  generateIdempotencyKey: idempotency.generateIdempotencyKey,
  checkIdempotency: idempotency.checkIdempotency,
  cacheIdempotencyResult: idempotency.cacheIdempotencyResult,
  idempotencyMiddleware: idempotency.idempotencyMiddleware,

  // Health Checks
  checkHealth: healthCheck.checkHealth,
  livenessCheck: healthCheck.livenessCheck,
  readinessCheck: healthCheck.readinessCheck,
  createHealthRouter: healthCheck.createHealthRouter,
};
