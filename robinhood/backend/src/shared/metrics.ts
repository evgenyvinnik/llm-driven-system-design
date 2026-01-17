/**
 * Prometheus metrics for the Robinhood trading platform.
 * Exposes metrics for HTTP requests, orders, executions, portfolio updates,
 * and system health indicators.
 *
 * Metrics enable:
 * - Real-time monitoring of order execution performance
 * - SLO tracking (latency, error rates)
 * - Capacity planning based on traffic patterns
 * - Alerting on anomalies (failed orders, high latency)
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/** Central registry for all metrics */
export const registry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop lag)
collectDefaultMetrics({ register: registry });

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/** Total HTTP requests by method, path, and status */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [registry],
});

/** HTTP request duration in milliseconds */
export const httpRequestDurationMs = new Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'path'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

// ============================================================================
// Order Metrics
// ============================================================================

/** Total orders placed by side and type */
export const ordersPlacedTotal = new Counter({
  name: 'orders_placed_total',
  help: 'Total number of orders placed',
  labelNames: ['side', 'order_type'],
  registers: [registry],
});

/** Total orders filled by side and type */
export const ordersFilledTotal = new Counter({
  name: 'orders_filled_total',
  help: 'Total number of orders filled',
  labelNames: ['side', 'order_type'],
  registers: [registry],
});

/** Total orders cancelled */
export const ordersCancelledTotal = new Counter({
  name: 'orders_cancelled_total',
  help: 'Total number of orders cancelled',
  registers: [registry],
});

/** Total orders rejected due to errors */
export const ordersRejectedTotal = new Counter({
  name: 'orders_rejected_total',
  help: 'Total number of orders rejected',
  labelNames: ['reason'],
  registers: [registry],
});

/** Order execution latency in milliseconds (from placement to fill) */
export const orderExecutionDurationMs = new Histogram({
  name: 'order_execution_duration_ms',
  help: 'Order execution duration in milliseconds',
  labelNames: ['order_type'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

/** Number of pending orders by type */
export const ordersPendingGauge = new Gauge({
  name: 'orders_pending',
  help: 'Number of pending orders',
  labelNames: ['order_type'],
  registers: [registry],
});

// ============================================================================
// Trade Execution Metrics
// ============================================================================

/** Total value of executions by side */
export const executionValueTotal = new Counter({
  name: 'execution_value_total',
  help: 'Total value of trade executions in dollars',
  labelNames: ['side'],
  registers: [registry],
});

/** Total shares traded by side */
export const executionSharesTotal = new Counter({
  name: 'execution_shares_total',
  help: 'Total number of shares executed',
  labelNames: ['side'],
  registers: [registry],
});

// ============================================================================
// Portfolio Metrics
// ============================================================================

/** Portfolio updates (position changes) */
export const portfolioUpdatesTotal = new Counter({
  name: 'portfolio_updates_total',
  help: 'Total number of portfolio position updates',
  labelNames: ['type'], // buy, sell
  registers: [registry],
});

// ============================================================================
// Quote Service Metrics
// ============================================================================

/** Total quote updates generated */
export const quoteUpdatesTotal = new Counter({
  name: 'quote_updates_total',
  help: 'Total number of quote updates generated',
  registers: [registry],
});

/** Number of WebSocket connections */
export const websocketConnectionsGauge = new Gauge({
  name: 'websocket_connections',
  help: 'Number of active WebSocket connections',
  labelNames: ['authenticated'],
  registers: [registry],
});

// ============================================================================
// Database Metrics
// ============================================================================

/** PostgreSQL connection pool size */
export const dbPoolSizeGauge = new Gauge({
  name: 'db_pool_size',
  help: 'Database connection pool size',
  labelNames: ['state'], // idle, busy
  registers: [registry],
});

/** Database query duration */
export const dbQueryDurationMs = new Histogram({
  name: 'db_query_duration_ms',
  help: 'Database query duration in milliseconds',
  labelNames: ['operation'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/** Circuit breaker state (0=closed, 1=open, 2=half-open) */
export const circuitBreakerStateGauge = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [registry],
});

/** Circuit breaker failures */
export const circuitBreakerFailuresTotal = new Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['name'],
  registers: [registry],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/** Total idempotency key hits (duplicate requests detected) */
export const idempotencyHitsTotal = new Counter({
  name: 'idempotency_hits_total',
  help: 'Total number of duplicate requests detected via idempotency keys',
  registers: [registry],
});

/** Total idempotency key misses (new requests) */
export const idempotencyMissesTotal = new Counter({
  name: 'idempotency_misses_total',
  help: 'Total number of new requests (idempotency key not found)',
  registers: [registry],
});

// ============================================================================
// Audit Metrics
// ============================================================================

/** Total audit log entries */
export const auditEntriesTotal = new Counter({
  name: 'audit_entries_total',
  help: 'Total number of audit log entries created',
  labelNames: ['action', 'status'],
  registers: [registry],
});
