import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics registry and collectors.
 *
 * Exposes key metrics for:
 * - Payment processing latency and success rates
 * - Transaction volumes by status and currency
 * - Fraud detection scores
 * - Circuit breaker state
 * - Database and Redis connection health
 *
 * Metrics endpoint: GET /metrics
 */

/** Custom registry for payment system metrics */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop)
collectDefaultMetrics({ register: metricsRegistry });

// ============================================================================
// Payment Processing Metrics
// ============================================================================

/**
 * HTTP request duration histogram.
 * Tracks latency of all API endpoints.
 * Labels: method, route, status_code
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Total payment transactions counter.
 * Labels: status (authorized, captured, failed, voided, refunded), currency
 */
export const paymentTransactionsTotal = new Counter({
  name: 'payment_transactions_total',
  help: 'Total number of payment transactions',
  labelNames: ['status', 'currency'] as const,
  registers: [metricsRegistry],
});

/**
 * Payment processing duration histogram.
 * Tracks time from request to response for payment operations.
 * Labels: operation (create, capture, void, refund), status
 */
export const paymentProcessingDuration = new Histogram({
  name: 'payment_processing_duration_seconds',
  help: 'Payment processing duration in seconds',
  labelNames: ['operation', 'status'] as const,
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

/**
 * Payment amount histogram.
 * Tracks distribution of transaction amounts (in cents).
 * Labels: currency
 */
export const paymentAmountHistogram = new Histogram({
  name: 'payment_amount_cents',
  help: 'Payment amount distribution in cents',
  labelNames: ['currency'] as const,
  buckets: [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 500000],
  registers: [metricsRegistry],
});

// ============================================================================
// Fraud Detection Metrics
// ============================================================================

/**
 * Fraud score histogram.
 * Tracks distribution of risk scores for fraud detection analysis.
 */
export const fraudScoreHistogram = new Histogram({
  name: 'fraud_score',
  help: 'Distribution of fraud risk scores',
  labelNames: ['outcome'] as const,
  buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
  registers: [metricsRegistry],
});

/**
 * Fraud decisions counter.
 * Labels: decision (approve, review, decline)
 */
export const fraudDecisionsTotal = new Counter({
  name: 'fraud_decisions_total',
  help: 'Total fraud detection decisions',
  labelNames: ['decision'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// Refund and Chargeback Metrics
// ============================================================================

/**
 * Refund transactions counter.
 * Labels: type (full, partial), status
 */
export const refundTransactionsTotal = new Counter({
  name: 'refund_transactions_total',
  help: 'Total number of refund transactions',
  labelNames: ['type', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Chargeback events counter.
 * Labels: status (open, won, lost)
 */
export const chargebackEventsTotal = new Counter({
  name: 'chargeback_events_total',
  help: 'Total number of chargeback events',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Circuit breaker state gauge.
 * Values: 0 = closed (healthy), 1 = half-open (testing), 2 = open (failing)
 * Labels: service (processor, fraud, webhook)
 */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'] as const,
  registers: [metricsRegistry],
});

/**
 * Circuit breaker events counter.
 * Labels: service, event (success, failure, state_change)
 */
export const circuitBreakerEvents = new Counter({
  name: 'circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['service', 'event'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// Database and Connection Metrics
// ============================================================================

/**
 * Database query duration histogram.
 * Labels: operation (select, insert, update, delete)
 */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Active database connections gauge.
 */
export const dbActiveConnections = new Gauge({
  name: 'db_active_connections',
  help: 'Number of active database connections',
  registers: [metricsRegistry],
});

/**
 * Redis operations counter.
 * Labels: operation (get, set, del), status (success, failure)
 */
export const redisOperationsTotal = new Counter({
  name: 'redis_operations_total',
  help: 'Total Redis operations',
  labelNames: ['operation', 'status'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/**
 * Idempotency cache hits and misses.
 * Labels: result (hit, miss)
 */
export const idempotencyCacheTotal = new Counter({
  name: 'idempotency_cache_total',
  help: 'Idempotency key cache lookups',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/**
 * Gets all metrics in Prometheus text format.
 * @returns Prometheus-formatted metrics string
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Gets the content type for Prometheus metrics.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export default metricsRegistry;
