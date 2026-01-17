/**
 * Prometheus Metrics Module
 *
 * Provides application metrics for monitoring and alerting.
 * Exposes metrics in Prometheus format at /metrics endpoint.
 *
 * WHY: Prometheus metrics enable real-time monitoring of:
 * - Request latency (P50, P95, P99) for SLA compliance
 * - Error rates for alerting and incident response
 * - Business metrics (payments processed, card provisioning)
 * - System health (circuit breaker state, connection pool usage)
 *
 * Metrics follow Prometheus naming conventions:
 * - Counter: monotonically increasing (requests_total)
 * - Histogram: value distribution (request_duration_seconds)
 * - Gauge: point-in-time value (active_connections)
 */
import client from 'prom-client';
import { Request, Response, NextFunction, Router } from 'express';

// Create a Registry to collect metrics
const register = new client.Registry();

// Add default Node.js metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register });

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/**
 * HTTP request duration histogram.
 * Buckets optimized for payment latency SLAs (< 500ms target).
 */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Total HTTP requests counter.
 */
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// ============================================================================
// Payment Metrics (Business Critical)
// ============================================================================

/**
 * Payment transaction counter by status and type.
 * Critical for monitoring approval rates and detecting issues.
 */
export const paymentTransactionsTotal = new client.Counter({
  name: 'payment_transactions_total',
  help: 'Total payment transactions by status and type',
  labelNames: ['status', 'transaction_type', 'network'],
  registers: [register],
});

/**
 * Payment processing duration histogram.
 * Target: P99 < 500ms for NFC, < 1s for in-app.
 */
export const paymentDuration = new client.Histogram({
  name: 'payment_duration_seconds',
  help: 'Payment processing duration in seconds',
  labelNames: ['transaction_type', 'network'],
  buckets: [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5],
  registers: [register],
});

/**
 * Payment amount histogram for business analytics.
 */
export const paymentAmountHistogram = new client.Histogram({
  name: 'payment_amount_usd',
  help: 'Payment amounts in USD',
  labelNames: ['transaction_type'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000],
  registers: [register],
});

// ============================================================================
// Card Provisioning Metrics
// ============================================================================

/**
 * Card provisioning counter by network and result.
 */
export const cardProvisioningTotal = new client.Counter({
  name: 'card_provisioning_total',
  help: 'Total card provisioning attempts',
  labelNames: ['network', 'result'],
  registers: [register],
});

/**
 * Active provisioned cards gauge.
 */
export const activeCardsGauge = new client.Gauge({
  name: 'active_cards_total',
  help: 'Number of active provisioned cards',
  labelNames: ['network'],
  registers: [register],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Circuit breaker state gauge (0=closed, 0.5=half-open, 1=open).
 */
export const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 0.5=half-open, 1=open)',
  labelNames: ['name'],
  registers: [register],
});

/**
 * Circuit breaker events counter.
 */
export const circuitBreakerEvents = new client.Counter({
  name: 'circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['name', 'event'],
  registers: [register],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/**
 * Idempotency cache hit/miss counter.
 */
export const idempotencyCacheOps = new client.Counter({
  name: 'idempotency_cache_operations_total',
  help: 'Idempotency cache operations',
  labelNames: ['operation', 'result'],
  registers: [register],
});

// ============================================================================
// Database Metrics
// ============================================================================

/**
 * Database connection pool gauge.
 */
export const dbConnectionPool = new client.Gauge({
  name: 'db_connection_pool',
  help: 'Database connection pool stats',
  labelNames: ['state'],
  registers: [register],
});

/**
 * Database query duration histogram.
 */
export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['query_type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// ============================================================================
// Middleware & Endpoint
// ============================================================================

/**
 * Express middleware for collecting HTTP metrics.
 * Records request duration and counts by method, route, and status.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1_000_000_000;

    // Normalize route path (replace UUIDs with :id)
    const route = req.route?.path || req.path.replace(/[a-f0-9-]{36}/gi, ':id');

    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Creates Express router with /metrics endpoint.
 * Returns Prometheus-formatted metrics for scraping.
 */
export function createMetricsRouter(): Router {
  const router = Router();

  router.get('/metrics', async (_req: Request, res: Response) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (error) {
      res.status(500).end((error as Error).message);
    }
  });

  return router;
}

/**
 * Helper to record payment transaction metrics.
 */
export function recordPaymentMetrics(
  status: 'approved' | 'declined' | 'error',
  transactionType: string,
  network: string,
  amount: number,
  durationMs: number
) {
  paymentTransactionsTotal.inc({ status, transaction_type: transactionType, network });
  paymentDuration.observe({ transaction_type: transactionType, network }, durationMs / 1000);
  paymentAmountHistogram.observe({ transaction_type: transactionType }, amount);
}

/**
 * Helper to record card provisioning metrics.
 */
export function recordProvisioningMetrics(
  network: string,
  result: 'success' | 'failure' | 'duplicate'
) {
  cardProvisioningTotal.inc({ network, result });
}

export { register };
export default {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  paymentTransactionsTotal,
  paymentDuration,
  circuitBreakerState,
  circuitBreakerEvents,
  idempotencyCacheOps,
  metricsMiddleware,
  createMetricsRouter,
  recordPaymentMetrics,
  recordProvisioningMetrics,
};
