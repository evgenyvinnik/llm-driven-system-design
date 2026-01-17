/**
 * Shared Modules Index
 *
 * Central export point for all shared infrastructure modules.
 * These modules provide cross-cutting concerns for the Apple Pay backend.
 */

// Structured logging with pino
export { logger, createChildLogger, requestLogger, LogLevel } from './logger.js';
export type { LogLevelType } from './logger.js';

// Prometheus metrics for monitoring
export {
  metricsMiddleware,
  createMetricsRouter,
  recordPaymentMetrics,
  recordProvisioningMetrics,
  httpRequestDuration,
  httpRequestsTotal,
  paymentTransactionsTotal,
  paymentDuration,
  circuitBreakerState,
  circuitBreakerEvents,
  idempotencyCacheOps,
  cardProvisioningTotal,
  activeCardsGauge,
  dbConnectionPool,
  dbQueryDuration,
  register,
} from './metrics.js';

// Idempotency middleware for payment safety
export {
  idempotencyMiddleware,
  generateIdempotencyKey,
  executeIdempotent,
} from './idempotency.js';

// Circuit breaker for payment network resilience
export {
  createCircuitBreaker,
  getCircuitBreakerStats,
  getAllCircuitBreakerStats,
  paymentNetworks,
  authorizeWithNetwork,
} from './circuit-breaker.js';
export type { NetworkAuthRequest, NetworkAuthResponse } from './circuit-breaker.js';

// Audit logging for compliance
export {
  auditLog,
  writeAuditLog,
  createAuditEntryFromRequest,
  queryAuditLogs,
  AuditAction,
} from './audit.js';
export type { AuditLogEntry } from './audit.js';

// Health check endpoints
export { default as healthRouter } from './health.js';
