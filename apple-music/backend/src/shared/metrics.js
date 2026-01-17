import promClient from 'prom-client';

/**
 * Prometheus metrics module for observability.
 *
 * Benefits:
 * - Enables SLI tracking (latency, error rates, throughput)
 * - Integrates with Grafana dashboards for visualization
 * - Supports alerting via Prometheus Alertmanager
 * - Provides system health insights (memory, CPU, event loop lag)
 */

// Create a registry to hold all metrics
export const register = new promClient.Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
promClient.collectDefaultMetrics({
  register,
  prefix: 'apple_music_'
});

// ============================================
// HTTP Request Metrics
// ============================================

/**
 * HTTP request duration histogram.
 * Tracks request latency by method, route, and status code.
 * Essential for p50/p95/p99 latency SLIs.
 */
export const httpRequestDuration = new promClient.Histogram({
  name: 'apple_music_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
});

/**
 * Total HTTP requests counter.
 * Used for throughput calculation and error rate computation.
 */
export const httpRequestsTotal = new promClient.Counter({
  name: 'apple_music_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// ============================================
// Streaming Metrics
// ============================================

/**
 * Stream start latency histogram.
 * Tracks time from stream request to first byte.
 * Critical SLI: Target < 200ms for 95th percentile.
 */
export const streamStartLatency = new promClient.Histogram({
  name: 'apple_music_stream_start_latency_seconds',
  help: 'Time from stream request to first byte',
  labelNames: ['quality', 'subscription_tier'],
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2],
  registers: [register]
});

/**
 * Active streams gauge.
 * Tracks currently active audio streams for capacity planning.
 */
export const activeStreams = new promClient.Gauge({
  name: 'apple_music_active_streams',
  help: 'Number of currently active audio streams',
  labelNames: ['quality'],
  registers: [register]
});

/**
 * Total streams counter.
 * Tracks streaming activity for analytics.
 */
export const streamsTotal = new promClient.Counter({
  name: 'apple_music_streams_total',
  help: 'Total number of streams started',
  labelNames: ['quality', 'subscription_tier'],
  registers: [register]
});

// ============================================
// Library/Playlist Metrics
// ============================================

/**
 * Library operations counter.
 * Tracks add/remove/sync operations for usage analytics.
 */
export const libraryOperations = new promClient.Counter({
  name: 'apple_music_library_operations_total',
  help: 'Library operations by type',
  labelNames: ['operation', 'item_type'],
  registers: [register]
});

/**
 * Playlist operations counter.
 * Tracks playlist CRUD and idempotency cache usage.
 */
export const playlistOperations = new promClient.Counter({
  name: 'apple_music_playlist_operations_total',
  help: 'Playlist operations by type',
  labelNames: ['operation', 'idempotent'],
  registers: [register]
});

// ============================================
// Search Metrics
// ============================================

/**
 * Search latency histogram.
 * Tracks search query performance by type.
 */
export const searchLatency = new promClient.Histogram({
  name: 'apple_music_search_latency_seconds',
  help: 'Search query latency',
  labelNames: ['search_type'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register]
});

// ============================================
// Cache Metrics
// ============================================

/**
 * Cache hit/miss counter.
 * Tracks cache effectiveness for Redis and in-memory caches.
 */
export const cacheHits = new promClient.Counter({
  name: 'apple_music_cache_hits_total',
  help: 'Cache hit/miss by cache type',
  labelNames: ['cache', 'result'],
  registers: [register]
});

// ============================================
// Auth Metrics
// ============================================

/**
 * Authentication attempts counter.
 * Tracks login success/failure for security monitoring.
 */
export const authAttempts = new promClient.Counter({
  name: 'apple_music_auth_attempts_total',
  help: 'Authentication attempts by result',
  labelNames: ['type', 'result'],
  registers: [register]
});

// ============================================
// Rate Limiting Metrics
// ============================================

/**
 * Rate limit hits counter.
 * Tracks when users hit rate limits.
 */
export const rateLimitHits = new promClient.Counter({
  name: 'apple_music_rate_limit_hits_total',
  help: 'Rate limit hits by endpoint category',
  labelNames: ['category'],
  registers: [register]
});

// ============================================
// Idempotency Metrics
// ============================================

/**
 * Idempotency cache usage counter.
 * Tracks idempotency key hits vs misses.
 */
export const idempotencyCache = new promClient.Counter({
  name: 'apple_music_idempotency_total',
  help: 'Idempotency cache hits and misses',
  labelNames: ['result'],
  registers: [register]
});

// ============================================
// Express Middleware
// ============================================

/**
 * HTTP metrics middleware.
 * Records request duration and counts for all routes.
 */
export function metricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;

    // Normalize route path for metric labels (avoid high cardinality)
    const route = normalizeRoute(req.route?.path || req.path);
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Normalize route paths to avoid high cardinality in metrics.
 * Replaces dynamic segments with placeholders.
 */
function normalizeRoute(path) {
  // Replace UUIDs with :id
  path = path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
  // Replace numeric IDs with :id
  path = path.replace(/\/\d+/g, '/:id');
  return path;
}

/**
 * Metrics endpoint handler.
 * Exposes metrics in Prometheus format at /metrics.
 */
export async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
}

export default {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  streamStartLatency,
  activeStreams,
  streamsTotal,
  libraryOperations,
  playlistOperations,
  searchLatency,
  cacheHits,
  authAttempts,
  rateLimitHits,
  idempotencyCache,
  metricsMiddleware,
  metricsHandler
};
