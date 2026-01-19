import client, {
  Registry,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import type { ExtendedRequest } from './logger.js';

/**
 * Prometheus Metrics Module
 *
 * Collects and exposes metrics for:
 * - Payment transactions (success/failure rates, latency)
 * - Fraud detection statistics
 * - Webhook delivery
 * - Infrastructure health (DB connections, Redis)
 * - Idempotency cache performance
 *
 * Metrics are exposed via /metrics endpoint in Prometheus format
 */

// Create a Registry to register the metrics
const register = new Registry();

// Add default metrics (memory, CPU, event loop lag, etc.)
client.collectDefaultMetrics({ register });

// ========================
// Payment Transaction Metrics
// ========================

export const paymentRequestsTotal = new Counter({
  name: 'payment_requests_total',
  help: 'Total number of payment requests',
  labelNames: ['method', 'endpoint', 'status_code', 'merchant_id'] as const,
  registers: [register],
});

export const paymentRequestDuration = new Histogram({
  name: 'payment_request_duration_seconds',
  help: 'Duration of payment requests in seconds',
  labelNames: ['method', 'endpoint', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const paymentAmountCents = new Histogram({
  name: 'payment_amount_cents',
  help: 'Distribution of payment amounts in cents',
  labelNames: ['currency', 'status'] as const,
  buckets: [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 500000],
  registers: [register],
});

export const activePaymentIntents = new Gauge({
  name: 'active_payment_intents',
  help: 'Current number of active payment intents by status',
  labelNames: ['status'] as const,
  registers: [register],
});

export const paymentSuccessTotal = new Counter({
  name: 'payment_success_total',
  help: 'Total number of successful payments',
  labelNames: ['currency', 'payment_method_type'] as const,
  registers: [register],
});

export const paymentFailureTotal = new Counter({
  name: 'payment_failure_total',
  help: 'Total number of failed payments',
  labelNames: ['decline_code', 'currency'] as const,
  registers: [register],
});

// ========================
// Fraud Detection Metrics
// ========================

export const fraudScoreDistribution = new Histogram({
  name: 'fraud_score_distribution',
  help: 'Distribution of fraud risk scores',
  labelNames: ['decision'] as const,
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [register],
});

export const fraudBlockedTotal = new Counter({
  name: 'fraud_blocked_total',
  help: 'Total payments blocked by fraud detection',
  labelNames: ['rule', 'risk_level'] as const,
  registers: [register],
});

export const fraudCheckDuration = new Histogram({
  name: 'fraud_check_duration_seconds',
  help: 'Duration of fraud risk assessment',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [register],
});

// ========================
// Webhook Metrics
// ========================

export const webhookDeliveriesTotal = new Counter({
  name: 'webhook_deliveries_total',
  help: 'Total webhook delivery attempts',
  labelNames: ['event_type', 'status', 'attempt'] as const,
  registers: [register],
});

export const webhookQueueDepth = new Gauge({
  name: 'webhook_queue_depth',
  help: 'Current number of webhooks waiting in queue',
  registers: [register],
});

export const webhookDeliveryDuration = new Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Duration of webhook delivery attempts',
  labelNames: ['event_type', 'status'] as const,
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// ========================
// Infrastructure Metrics
// ========================

export const dbConnectionPoolSize = new Gauge({
  name: 'db_connection_pool_size',
  help: 'Database connection pool size by state',
  labelNames: ['state'] as const, // active, idle, waiting
  registers: [register],
});

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const redisMemoryBytes = new Gauge({
  name: 'redis_memory_bytes',
  help: 'Redis memory usage in bytes',
  registers: [register],
});

export const redisOperationDuration = new Histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Duration of Redis operations',
  labelNames: ['operation'] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05],
  registers: [register],
});

// ========================
// Idempotency Metrics
// ========================

export const idempotencyCacheHitsTotal = new Counter({
  name: 'idempotency_cache_hits_total',
  help: 'Total number of idempotency cache hits (duplicate requests)',
  registers: [register],
});

export const idempotencyCacheMissesTotal = new Counter({
  name: 'idempotency_cache_misses_total',
  help: 'Total number of idempotency cache misses (new requests)',
  registers: [register],
});

export const idempotencyLockConflictsTotal = new Counter({
  name: 'idempotency_lock_conflicts_total',
  help: 'Total number of idempotency lock conflicts (409 responses)',
  registers: [register],
});

// ========================
// Circuit Breaker Metrics
// ========================

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'] as const,
  registers: [register],
});

export const circuitBreakerFailuresTotal = new Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total failures recorded by circuit breaker',
  labelNames: ['service'] as const,
  registers: [register],
});

// ========================
// Ledger Metrics
// ========================

export const ledgerEntriesTotal = new Counter({
  name: 'ledger_entries_total',
  help: 'Total ledger entries created',
  labelNames: ['type', 'account'] as const,
  registers: [register],
});

export const ledgerImbalancesTotal = new Counter({
  name: 'ledger_imbalances_total',
  help: 'Total ledger imbalance errors detected',
  registers: [register],
});

// ========================
// Refund Metrics
// ========================

export const refundsTotal = new Counter({
  name: 'refunds_total',
  help: 'Total refunds processed',
  labelNames: ['status', 'reason'] as const,
  registers: [register],
});

export const refundAmountCents = new Histogram({
  name: 'refund_amount_cents',
  help: 'Distribution of refund amounts in cents',
  buckets: [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
  registers: [register],
});

// ========================
// Helper Functions
// ========================

/**
 * Express middleware to track request metrics
 */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startTime = process.hrtime();

  // Record response metrics after response is sent
  res.on('finish', () => {
    const [seconds, nanoseconds] = process.hrtime(startTime);
    const durationSeconds = seconds + nanoseconds / 1e9;

    // Get clean endpoint path (replace IDs with :id)
    const endpoint = req.route
      ? req.baseUrl + req.route.path
      : req.path.replace(/[a-f0-9-]{36}/gi, ':id');

    paymentRequestsTotal.inc({
      method: req.method,
      endpoint,
      status_code: res.statusCode.toString(),
      merchant_id: (req as ExtendedRequest).merchantId || 'unknown',
    });

    paymentRequestDuration.observe(
      {
        method: req.method,
        endpoint,
        status: res.statusCode < 400 ? 'success' : 'error',
      },
      durationSeconds
    );
  });

  next();
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get content type for metrics
 */
export function getMetricsContentType(): string {
  return register.contentType;
}

/**
 * Record a payment success
 */
export function recordPaymentSuccess(
  amount: number,
  currency: string,
  paymentMethodType: string = 'card'
): void {
  paymentSuccessTotal.inc({ currency, payment_method_type: paymentMethodType });
  paymentAmountCents.observe({ currency, status: 'success' }, amount);
}

/**
 * Record a payment failure
 */
export function recordPaymentFailure(
  declineCode: string,
  currency: string,
  amount: number
): void {
  paymentFailureTotal.inc({ decline_code: declineCode, currency });
  paymentAmountCents.observe({ currency, status: 'failure' }, amount);
}

/**
 * Record fraud check result
 */
export function recordFraudCheck(
  score: number,
  decision: string,
  rule: string = 'aggregate'
): void {
  fraudScoreDistribution.observe({ decision }, score);
  if (decision === 'block') {
    fraudBlockedTotal.inc({ rule, risk_level: score > 0.8 ? 'high' : 'medium' });
  }
}

/**
 * Update circuit breaker state metric
 */
export function updateCircuitBreakerState(
  service: string,
  state: string
): void {
  const stateValue = state === 'closed' ? 0 : state === 'half-open' ? 1 : 2;
  circuitBreakerState.set({ service }, stateValue);
}

export { register };
