import promClient, { Histogram, Counter, Gauge, Registry } from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';

/**
 * Prometheus metrics for observability.
 *
 * WHY: Prometheus metrics enable:
 * - Real-time system monitoring and alerting
 * - Performance bottleneck identification
 * - Capacity planning via historical trends
 * - SLA/SLO tracking (latency percentiles, error rates)
 *
 * These metrics follow the RED method:
 * - Rate: requests per second
 * - Errors: failed requests per second
 * - Duration: time per request
 */

// Create a Registry which registers the metrics
const register: Registry = new promClient.Registry();

// Add default labels
register.setDefaultLabels({
  app: 'health-data-pipeline',
  env: config.nodeEnv
});

// Collect default metrics (CPU, memory, event loop, GC)
promClient.collectDefaultMetrics({
  register,
  prefix: 'health_pipeline_'
});

// ----- HTTP Request Metrics -----

/**
 * HTTP request duration histogram (for latency percentiles).
 * Buckets optimized for API response times.
 */
export const httpRequestDuration: Histogram<string> = new promClient.Histogram({
  name: 'health_pipeline_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

/**
 * HTTP request counter (for rate calculation).
 */
export const httpRequestTotal: Counter<string> = new promClient.Counter({
  name: 'health_pipeline_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// ----- Health Data Metrics -----

/**
 * Health samples ingested counter.
 */
export const samplesIngestedTotal: Counter<string> = new promClient.Counter({
  name: 'health_pipeline_samples_ingested_total',
  help: 'Total number of health samples ingested',
  labelNames: ['type', 'device_type', 'status'],
  registers: [register]
});

/**
 * Sync operation duration histogram.
 */
export const syncDuration: Histogram<string> = new promClient.Histogram({
  name: 'health_pipeline_sync_duration_seconds',
  help: 'Duration of device sync operations in seconds',
  labelNames: ['device_type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

/**
 * Aggregation operation duration.
 */
export const aggregationDuration: Histogram<string> = new promClient.Histogram({
  name: 'health_pipeline_aggregation_duration_seconds',
  help: 'Duration of aggregation operations in seconds',
  labelNames: ['type', 'period'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register]
});

/**
 * Active users gauge (users with data synced in last 24h).
 */
export const activeUsers: Gauge<string> = new promClient.Gauge({
  name: 'health_pipeline_active_users',
  help: 'Number of active users (synced in last 24h)',
  registers: [register]
});

// ----- Database Metrics -----

/**
 * Database query duration histogram.
 */
export const dbQueryDuration: Histogram<string> = new promClient.Histogram({
  name: 'health_pipeline_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register]
});

/**
 * Database connection pool metrics.
 */
export const dbPoolSize: Gauge<string> = new promClient.Gauge({
  name: 'health_pipeline_db_pool_size',
  help: 'Database connection pool size',
  labelNames: ['state'], // idle, active, waiting
  registers: [register]
});

// ----- Cache Metrics -----

/**
 * Cache hit/miss counter.
 */
export const cacheOperations: Counter<string> = new promClient.Counter({
  name: 'health_pipeline_cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['operation', 'result'], // get/set, hit/miss
  registers: [register]
});

// ----- Idempotency Metrics -----

/**
 * Idempotency key operations.
 */
export const idempotencyOperations: Counter<string> = new promClient.Counter({
  name: 'health_pipeline_idempotency_operations_total',
  help: 'Idempotency key operations',
  labelNames: ['result'], // new, duplicate, expired
  registers: [register]
});

// ----- Express Middleware -----

interface RouteRequest extends Request {
  route?: {
    path?: string;
  };
  baseUrl?: string;
}

/**
 * Middleware to record HTTP metrics.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = getRoutePath(req as RouteRequest);
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString()
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestTotal.inc(labels);
  });

  next();
}

/**
 * Extract route pattern from request (normalize path params).
 */
function getRoutePath(req: RouteRequest): string {
  // Use the matched route pattern if available
  if (req.route && req.route.path) {
    return (req.baseUrl || '') + req.route.path;
  }

  // Fall back to URL, but normalize IDs
  return req.path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/**
 * Endpoint to expose metrics for Prometheus scraping.
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get content type for metrics response.
 */
export function getMetricsContentType(): string {
  return register.contentType;
}

/**
 * Helper to time async operations.
 */
export function createTimer(histogram: Histogram<string>, labels: Record<string, string>): () => number {
  const start = Date.now();
  return (): number => {
    const duration = (Date.now() - start) / 1000;
    histogram.observe(labels, duration);
    return duration;
  };
}

interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/**
 * Record database pool metrics.
 */
export function recordPoolMetrics(pool: PoolStats): void {
  dbPoolSize.set({ state: 'total' }, pool.totalCount);
  dbPoolSize.set({ state: 'idle' }, pool.idleCount);
  dbPoolSize.set({ state: 'waiting' }, pool.waitingCount);
}

export { register };
export default {
  register,
  httpRequestDuration,
  httpRequestTotal,
  samplesIngestedTotal,
  syncDuration,
  aggregationDuration,
  activeUsers,
  dbQueryDuration,
  dbPoolSize,
  cacheOperations,
  idempotencyOperations,
  metricsMiddleware,
  getMetrics,
  getMetricsContentType,
  createTimer,
  recordPoolMetrics
};
