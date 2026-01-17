import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { Request, Response, NextFunction } from 'express';

/**
 * Prometheus metrics for observability and monitoring.
 *
 * WHY PROMETHEUS METRICS:
 * - Industry standard for cloud-native monitoring (Kubernetes, Grafana)
 * - Pull-based model reduces coupling (metrics server fetches from apps)
 * - Multi-dimensional labels enable flexible aggregation and alerting
 * - Histograms provide percentile calculations for SLO tracking
 *
 * METRICS PHILOSOPHY (RED Method):
 * - Rate: How many requests per second?
 * - Errors: How many requests fail?
 * - Duration: How long do requests take?
 *
 * These metrics enable SLI/SLO monitoring and capacity planning.
 */

// Create a custom registry for this application
export const metricsRegistry = new Registry();

// Set default labels for all metrics
metricsRegistry.setDefaultLabels({
  app: 'findmy-backend',
});

// Collect Node.js default metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * HTTP request counter (Rate in RED).
 * Tracks total number of requests by method, route, and status.
 * Use for: throughput monitoring, traffic analysis.
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

/**
 * HTTP request duration histogram (Duration in RED).
 * Tracks request latency distribution with percentile buckets.
 * Use for: SLO monitoring (e.g., 99th percentile < 200ms).
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  // Buckets optimized for API responses (10ms to 10s)
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Location reports counter.
 * Tracks ingestion rate of crowd-sourced location reports.
 * Use for: capacity planning, anomaly detection.
 */
export const locationReportsTotal = new Counter({
  name: 'location_reports_total',
  help: 'Total number of location reports submitted',
  labelNames: ['region', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Location cache operations counter.
 * Tracks cache hit/miss ratio for efficiency monitoring.
 * Use for: cache tuning, TTL optimization.
 */
export const cacheOperations = new Counter({
  name: 'cache_operations_total',
  help: 'Total number of cache operations',
  labelNames: ['operation', 'result'] as const, // operation: get/set, result: hit/miss
  registers: [metricsRegistry],
});

/**
 * Active sessions gauge.
 * Tracks current number of authenticated user sessions.
 * Use for: capacity monitoring, scaling decisions.
 */
export const activeSessions = new Gauge({
  name: 'active_sessions',
  help: 'Number of active user sessions',
  registers: [metricsRegistry],
});

/**
 * Registered devices gauge.
 * Tracks total number of devices in the system.
 * Use for: growth tracking, database capacity planning.
 */
export const registeredDevices = new Gauge({
  name: 'registered_devices',
  help: 'Number of registered devices',
  labelNames: ['device_type'] as const,
  registers: [metricsRegistry],
});

/**
 * Database query duration histogram.
 * Tracks PostgreSQL query performance by operation type.
 * Use for: slow query detection, index optimization decisions.
 */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Redis operation duration histogram.
 * Tracks Redis/Valkey cache operation performance.
 * Use for: cache latency monitoring, connection pool tuning.
 */
export const redisOperationDuration = new Histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Duration of Redis operations in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [metricsRegistry],
});

/**
 * Idempotency deduplication counter.
 * Tracks how many duplicate requests are detected and rejected.
 * Use for: replay attack detection, client retry analysis.
 */
export const idempotencyDedupes = new Counter({
  name: 'idempotency_dedupes_total',
  help: 'Total number of duplicate requests rejected',
  labelNames: ['endpoint'] as const,
  registers: [metricsRegistry],
});

/**
 * Rate limit counter.
 * Tracks rate-limited requests by endpoint.
 * Use for: abuse detection, rate limit tuning.
 */
export const rateLimitHits = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate-limited requests',
  labelNames: ['endpoint'] as const,
  registers: [metricsRegistry],
});

/**
 * Express middleware to track HTTP request metrics.
 * Records request count, duration, and labels for each request.
 *
 * NOTE: Route is normalized (e.g., /devices/:id) to prevent high cardinality.
 */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9; // Convert to seconds

    // Normalize route to prevent high cardinality (replace UUIDs/IDs with :id)
    const route = normalizeRoute(req.route?.path || req.path);

    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    });

    httpRequestDuration.observe(
      {
        method: req.method,
        route,
        status_code: res.statusCode.toString(),
      },
      duration
    );
  });

  next();
}

/**
 * Normalize a route path to prevent high cardinality in metrics.
 * Replaces UUIDs and numeric IDs with placeholder tokens.
 *
 * @param path - The raw request path
 * @returns Normalized path with IDs replaced
 */
function normalizeRoute(path: string): string {
  return path
    // Replace UUIDs (8-4-4-4-12 format)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    // Replace numeric IDs
    .replace(/\/\d+/g, '/:id');
}

/**
 * Express route handler for /metrics endpoint.
 * Returns Prometheus-formatted metrics for scraping.
 *
 * @example
 * app.get('/metrics', metricsHandler);
 */
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (error) {
    res.status(500).end('Error collecting metrics');
  }
}

export default metricsRegistry;
