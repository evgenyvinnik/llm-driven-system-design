/**
 * Shared modules index
 *
 * Exports all shared modules for easy importing:
 * - Logger: Structured logging with pino
 * - Metrics: Prometheus metrics for observability
 * - Circuit Breaker: Resilience patterns for external calls
 * - Idempotency: Safe request retries
 */

const logger = require('./logger');
const metrics = require('./metrics');
const circuitBreaker = require('./circuitBreaker');
const idempotency = require('./idempotency');

module.exports = {
  // Logger exports
  logger: logger.logger,
  auditLogger: logger.auditLogger,
  auditLog: logger.auditLog,
  AuditEvents: logger.AuditEvents,
  requestLoggerMiddleware: logger.requestLoggerMiddleware,

  // Metrics exports
  metrics,
  metricsMiddleware: metrics.metricsMiddleware,
  metricsHandler: metrics.metricsHandler,

  // Circuit breaker exports
  withCircuitBreaker: circuitBreaker.withCircuitBreaker,
  getCircuitBreakerHealth: circuitBreaker.getCircuitBreakerHealth,
  createCircuitBreaker: circuitBreaker.createCircuitBreaker,

  // Idempotency exports
  idempotencyMiddleware: idempotency.idempotencyMiddleware,
  watchProgressIdempotency: idempotency.watchProgressIdempotency,
  completeWatchProgressIdempotency: idempotency.completeWatchProgressIdempotency
};
