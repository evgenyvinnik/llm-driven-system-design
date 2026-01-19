/**
 * @fileoverview Prometheus metrics collection and exposition.
 *
 * Provides application metrics using the prom-client library for monitoring:
 * - HTTP request metrics (duration, count, status codes)
 * - Metrics ingestion throughput and latency
 * - Query execution metrics (cache hits/misses, latency)
 * - Dashboard render metrics
 * - Database connection pool stats
 * - Circuit breaker state
 *
 * Exposes metrics at /metrics endpoint in Prometheus text format.
 */

import _client, {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import { Request, Response, NextFunction, Router } from 'express';

/**
 * Custom Prometheus registry.
 * Using a custom registry allows for better control over which metrics are exposed.
 */
export const register = new Registry();

/**
 * Set default labels for all metrics.
 */
register.setDefaultLabels({
  app: 'dashboarding',
  service: process.env.SERVICE_NAME || 'api',
});

/**
 * Collect default Node.js metrics (CPU, memory, event loop, etc.)
 */
collectDefaultMetrics({ register });

// =============================================================================
// HTTP Request Metrics
// =============================================================================

/**
 * Counter for total HTTP requests received.
 * Labels: method, route, status_code
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/**
 * Histogram for HTTP request duration in seconds.
 * Labels: method, route, status_code
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// =============================================================================
// Metrics Ingestion Metrics
// =============================================================================

/**
 * Counter for total data points ingested.
 */
export const ingestPointsTotal = new Counter({
  name: 'ingest_points_total',
  help: 'Total number of metric data points ingested',
  registers: [register],
});

/**
 * Counter for total ingestion requests.
 */
export const ingestRequestsTotal = new Counter({
  name: 'ingest_requests_total',
  help: 'Total number of ingestion API requests',
  labelNames: ['status'],
  registers: [register],
});

/**
 * Histogram for ingestion latency in seconds.
 */
export const ingestLatency = new Histogram({
  name: 'ingest_latency_seconds',
  help: 'Metrics ingestion latency in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// =============================================================================
// Query Metrics
// =============================================================================

/**
 * Counter for total query requests.
 */
export const queryRequestsTotal = new Counter({
  name: 'query_requests_total',
  help: 'Total number of metric query requests',
  labelNames: ['status', 'cache_hit'],
  registers: [register],
});

/**
 * Histogram for query execution duration in seconds.
 */
export const queryDuration = new Histogram({
  name: 'query_duration_seconds',
  help: 'Metric query execution duration in seconds',
  labelNames: ['cache_hit', 'table'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Counter for cache hits and misses.
 */
export const cacheOperations = new Counter({
  name: 'cache_operations_total',
  help: 'Cache operations (hits and misses)',
  labelNames: ['operation', 'result'],
  registers: [register],
});

// =============================================================================
// Dashboard Metrics
// =============================================================================

/**
 * Counter for dashboard render requests.
 */
export const dashboardRendersTotal = new Counter({
  name: 'dashboard_renders_total',
  help: 'Total number of dashboard render requests',
  labelNames: ['status'],
  registers: [register],
});

/**
 * Counter for panel data fetch requests.
 */
export const panelDataFetchTotal = new Counter({
  name: 'panel_data_fetch_total',
  help: 'Total number of panel data fetch requests',
  labelNames: ['panel_type', 'status'],
  registers: [register],
});

// =============================================================================
// Database Metrics
// =============================================================================

/**
 * Gauge for active database connections.
 */
export const dbConnectionsActive = new Gauge({
  name: 'db_connections_active',
  help: 'Number of active database connections',
  registers: [register],
});

/**
 * Gauge for idle database connections.
 */
export const dbConnectionsIdle = new Gauge({
  name: 'db_connections_idle',
  help: 'Number of idle database connections',
  registers: [register],
});

/**
 * Gauge for total database connections.
 */
export const dbConnectionsTotal = new Gauge({
  name: 'db_connections_total',
  help: 'Total number of database connections',
  registers: [register],
});

// =============================================================================
// Circuit Breaker Metrics
// =============================================================================

/**
 * Gauge for circuit breaker state (0=closed, 1=open, 0.5=half-open).
 */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
  labelNames: ['name'],
  registers: [register],
});

/**
 * Counter for circuit breaker events.
 */
export const circuitBreakerEvents = new Counter({
  name: 'circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['name', 'event'],
  registers: [register],
});

// =============================================================================
// Alert Metrics
// =============================================================================

/**
 * Gauge for currently firing alerts.
 */
export const alertsFiring = new Gauge({
  name: 'alerts_firing',
  help: 'Number of currently firing alerts',
  labelNames: ['severity'],
  registers: [register],
});

/**
 * Counter for alert evaluations.
 */
export const alertEvaluationsTotal = new Counter({
  name: 'alert_evaluations_total',
  help: 'Total number of alert rule evaluations',
  labelNames: ['result'],
  registers: [register],
});

// =============================================================================
// Middleware and Router
// =============================================================================

/**
 * Express middleware to record HTTP request metrics.
 *
 * Records:
 * - Request count by method, route, and status code
 * - Request duration histogram
 *
 * Should be added early in the middleware chain to capture all requests.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9; // Convert to seconds

    // Normalize route for metrics (avoid high cardinality from dynamic params)
    const route = req.route?.path || req.path || 'unknown';
    const normalizedRoute = normalizeRoute(route);

    const labels = {
      method: req.method,
      route: normalizedRoute,
      status_code: res.statusCode.toString(),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
  });

  next();
}

/**
 * Normalizes route paths to prevent high cardinality in metrics.
 * Replaces dynamic segments (UUIDs, numeric IDs) with placeholders.
 *
 * @param route - The original route path
 * @returns Normalized route with placeholders
 */
function normalizeRoute(route: string): string {
  return route
    // Replace UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    // Replace numeric IDs
    .replace(/\/\d+/g, '/:id');
}

/**
 * Express router that exposes the /metrics endpoint.
 *
 * Returns metrics in Prometheus text exposition format.
 * Should be mounted at the root level of the Express app.
 */
export const metricsRouter = Router();

metricsRouter.get('/metrics', async (req: Request, res: Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (_error) {
    res.status(500).end('Error collecting metrics');
  }
});

export default {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  ingestPointsTotal,
  ingestRequestsTotal,
  ingestLatency,
  queryRequestsTotal,
  queryDuration,
  cacheOperations,
  dashboardRendersTotal,
  panelDataFetchTotal,
  dbConnectionsActive,
  dbConnectionsIdle,
  dbConnectionsTotal,
  circuitBreakerState,
  circuitBreakerEvents,
  alertsFiring,
  alertEvaluationsTotal,
  metricsMiddleware,
  metricsRouter,
};
