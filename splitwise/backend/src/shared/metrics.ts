/**
 * Prometheus metrics for observability
 *
 * WHY: Metrics enable real-time monitoring of system health, alerting on SLI
 * violations (error rates, latency), capacity planning, and incident RCA.
 */

import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';

export const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ============================================================================
// BUSINESS METRICS
// ============================================================================

/** Counter for expenses created, labelled by split type. */
export const expensesTotal = new client.Counter({
  name: 'splitwise_expenses_total',
  help: 'Total number of expenses created',
  labelNames: ['split_type'] as const,
  registers: [register],
});

/** Histogram of expense amounts in cents. */
export const expenseAmountHistogram = new client.Histogram({
  name: 'splitwise_expense_amount_cents',
  help: 'Distribution of expense amounts in cents',
  buckets: [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
  registers: [register],
});

/** Counter for recorded settlements. */
export const settlementsTotal = new client.Counter({
  name: 'splitwise_settlements_total',
  help: 'Total number of settlements recorded',
  labelNames: ['method'] as const,
  registers: [register],
});

/** Histogram of debt-simplification runtime (net balances -> minimal transfers). */
export const debtSimplifyDuration = new client.Histogram({
  name: 'splitwise_debt_simplify_duration_seconds',
  help: 'Time to compute simplified debts for a group',
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
  registers: [register],
});

// ============================================================================
// SYSTEM METRICS
// ============================================================================

export const httpRequestDuration = new client.Histogram({
  name: 'splitwise_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'splitwise_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const balanceCacheHits = new client.Counter({
  name: 'splitwise_balance_cache_hits_total',
  help: 'Group-balance cache hits',
  registers: [register],
});

export const balanceCacheMisses = new client.Counter({
  name: 'splitwise_balance_cache_misses_total',
  help: 'Group-balance cache misses',
  registers: [register],
});

export const idempotencyCacheHits = new client.Counter({
  name: 'splitwise_idempotency_cache_hits_total',
  help: 'Number of duplicate requests prevented by idempotency keys',
  registers: [register],
});

// ============================================================================
// INFRASTRUCTURE METRICS
// ============================================================================

export const pgPoolActiveConnections = new client.Gauge({
  name: 'splitwise_postgres_connections_active',
  help: 'Active PostgreSQL connections',
  registers: [register],
});

export const pgPoolIdleConnections = new client.Gauge({
  name: 'splitwise_postgres_connections_idle',
  help: 'Idle PostgreSQL connections',
  registers: [register],
});

export const pgPoolWaitingCount = new client.Gauge({
  name: 'splitwise_postgres_connections_waiting',
  help: 'Waiting PostgreSQL connection requests',
  registers: [register],
});

// ============================================================================
// HELPERS
// ============================================================================

/** Express middleware that records HTTP request latency and counts. */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = normalizeRoute(req.route?.path || req.path);
    const labels = { method: req.method, route, status_code: res.statusCode };

    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/** Normalize route paths by replacing UUIDs and numeric IDs with :id. */
export function normalizeRoute(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id');
}

/** Update PostgreSQL pool gauges from the live pool state. */
export function updatePoolMetrics(pool: pg.Pool): void {
  if (pool) {
    pgPoolActiveConnections.set(pool.totalCount - pool.idleCount);
    pgPoolIdleConnections.set(pool.idleCount);
    pgPoolWaitingCount.set(pool.waitingCount);
  }
}
