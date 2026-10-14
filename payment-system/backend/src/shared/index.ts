/**
 * Shared modules for the payment system.
 *
 * This module exports common utilities used across services:
 * - Logger: Structured JSON logging with Pino
 * - Metrics: Prometheus metrics collection
 * - Circuit Breaker: Resilience for external service calls
 * - Audit: Compliance logging for financial operations
 * - Queue: RabbitMQ integration for async processing
 */

// Logging
export { logger, auditLogger, createChildLogger, logAuditEvent } from './logger.js';

// Metrics
export {
  metricsRegistry,
  httpRequestDuration,
  paymentTransactionsTotal,
  paymentProcessingDuration,
  paymentAmountHistogram,
  fraudScoreHistogram,
  fraudDecisionsTotal,
  refundTransactionsTotal,
  chargebackEventsTotal,
  circuitBreakerState,
  circuitBreakerEvents,
  dbQueryDuration,
  dbActiveConnections,
  redisOperationsTotal,
  idempotencyRequestsTotal,
  paymentReconcileTotal,
  getMetrics,
  getMetricsContentType,
} from './metrics.js';

// Circuit Breaker
export {
  createCircuitBreaker,
  createRetryPolicy,
  processorCircuitBreaker,
  fraudCircuitBreaker,
  webhookCircuitBreaker,
  withResilience,
  withRetry,
} from './circuit-breaker.js';

// Audit Logging
export {
  recordAuditLog,
  auditPaymentCreated,
  auditPaymentAuthorized,
  auditPaymentCaptured,
  auditPaymentVoided,
  auditPaymentFailed,
  auditRefundCreated,
  auditChargebackCreated,
  auditMerchantStatusChanged,
  type AuditEntityType,
  type AuditActorType,
  type AuditAction,
  type AuditLogEntry,
} from './audit.js';

// Queue (RabbitMQ)
export {
  connectQueue,
  closeQueue,
  publishWebhook,
  publishFraudCheck,
  publishSettlement,
  consumeWebhooks,
  consumeFraudChecks,
  consumeSettlements,
  requeueWebhook,
  QUEUES,
  queueMessagesPublished,
  queueMessagesConsumed,
  queueProcessingDuration,
  type WebhookMessage,
  type FraudCheckMessage,
  type SettlementMessage,
  type MessageHandler,
} from './queue.js';
