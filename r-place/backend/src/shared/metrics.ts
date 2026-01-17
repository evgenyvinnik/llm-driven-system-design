/**
 * Prometheus metrics for observability.
 *
 * Exposes metrics for:
 * - Pixel placements (counter by color)
 * - Active WebSocket connections (gauge)
 * - HTTP request duration and count
 * - Rate limit hits
 * - Canvas updates
 * - Redis and PostgreSQL operations
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

/**
 * Custom registry for application metrics.
 * Allows separation from default Node.js metrics if needed.
 */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Counter for total pixels placed, labeled by color index.
 */
export const pixelsPlacedTotal = new Counter({
  name: 'rplace_pixels_placed_total',
  help: 'Total number of pixels placed',
  labelNames: ['color'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge for current number of active WebSocket connections.
 */
export const activeWebSocketConnections = new Gauge({
  name: 'rplace_active_websocket_connections',
  help: 'Number of active WebSocket connections',
  registers: [metricsRegistry],
});

/**
 * Gauge for number of active users (placed pixel in last 5 minutes).
 */
export const activeUsers = new Gauge({
  name: 'rplace_active_users',
  help: 'Number of users who placed a pixel in the last 5 minutes',
  registers: [metricsRegistry],
});

/**
 * Counter for rate limit rejections.
 */
export const rateLimitHitsTotal = new Counter({
  name: 'rplace_rate_limit_hits_total',
  help: 'Total number of rate limit rejections',
  registers: [metricsRegistry],
});

/**
 * Counter for canvas updates broadcast via WebSocket.
 */
export const canvasUpdatesTotal = new Counter({
  name: 'rplace_canvas_updates_total',
  help: 'Total number of canvas updates broadcast',
  registers: [metricsRegistry],
});

/**
 * Histogram for HTTP request duration.
 */
export const httpRequestDuration = new Histogram({
  name: 'rplace_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/**
 * Counter for HTTP requests.
 */
export const httpRequestsTotal = new Counter({
  name: 'rplace_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for pixel placement latency.
 */
export const pixelPlacementDuration = new Histogram({
  name: 'rplace_pixel_placement_duration_seconds',
  help: 'Pixel placement operation duration in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [metricsRegistry],
});

/**
 * Counter for Redis operations.
 */
export const redisOperationsTotal = new Counter({
  name: 'rplace_redis_operations_total',
  help: 'Total number of Redis operations',
  labelNames: ['operation', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for Redis operation duration.
 */
export const redisOperationDuration = new Histogram({
  name: 'rplace_redis_operation_duration_seconds',
  help: 'Redis operation duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [metricsRegistry],
});

/**
 * Counter for PostgreSQL queries.
 */
export const postgresQueriesTotal = new Counter({
  name: 'rplace_postgres_queries_total',
  help: 'Total number of PostgreSQL queries',
  labelNames: ['query_type', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for PostgreSQL query duration.
 */
export const postgresQueryDuration = new Histogram({
  name: 'rplace_postgres_query_duration_seconds',
  help: 'PostgreSQL query duration in seconds',
  labelNames: ['query_type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Gauge for circuit breaker state.
 * 0 = closed (healthy), 1 = open (failing), 0.5 = half-open (testing)
 */
export const circuitBreakerState = new Gauge({
  name: 'rplace_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 0.5=halfOpen, 1=open)',
  labelNames: ['name'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for idempotency cache hits.
 */
export const idempotencyCacheHits = new Counter({
  name: 'rplace_idempotency_cache_hits_total',
  help: 'Total number of idempotency cache hits (duplicate requests)',
  registers: [metricsRegistry],
});

/**
 * Counter for canvas snapshots created.
 */
export const snapshotsCreatedTotal = new Counter({
  name: 'rplace_snapshots_created_total',
  help: 'Total number of canvas snapshots created',
  registers: [metricsRegistry],
});

/**
 * Express middleware to track HTTP request metrics.
 */
export function metricsMiddleware(
  req: { method: string; path: string },
  res: { statusCode: number; on: (event: string, callback: () => void) => void },
  next: () => void
) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const path = normalizePath(req.path);

    httpRequestDuration.observe(
      { method: req.method, path, status: res.statusCode.toString() },
      duration
    );
    httpRequestsTotal.inc({
      method: req.method,
      path,
      status: res.statusCode.toString(),
    });
  });

  next();
}

/**
 * Normalizes paths for consistent metric labels.
 * Replaces dynamic segments like IDs with placeholders.
 */
function normalizePath(path: string): string {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[0-9a-f-]{36}/g, '/:uuid')
    .replace(/\/pixel\/\d+\/\d+/, '/pixel/:x/:y');
}

/**
 * Returns all metrics in Prometheus exposition format.
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Returns the content type for Prometheus metrics.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}
