import client, { Registry, Histogram, Counter, Gauge } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';
import config from '../config/index.js';

/**
 * Prometheus metrics module
 *
 * Provides standard metrics for:
 * - HTTP request duration and count
 * - Posts, likes, follows operations
 * - Feed generation latency
 * - Image processing duration
 * - Cache hit/miss ratio
 * - Active sessions gauge
 */

// Create a Registry which registers the metrics
const register = new Registry();

// Add default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({
  register,
  prefix: 'instagram_',
  labels: { service: 'api', port: String(config.port) },
});

// HTTP Request metrics
export const httpRequestDuration: Histogram<string> = new client.Histogram({
  name: 'instagram_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal: Counter<string> = new client.Counter({
  name: 'instagram_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// Posts metrics
export const postsCreatedTotal: Counter<string> = new client.Counter({
  name: 'instagram_posts_created_total',
  help: 'Total number of posts created',
  registers: [register],
});

export const postsDeletedTotal: Counter<string> = new client.Counter({
  name: 'instagram_posts_deleted_total',
  help: 'Total number of posts deleted',
  registers: [register],
});

// Likes metrics
export const likesTotal: Counter<string> = new client.Counter({
  name: 'instagram_likes_total',
  help: 'Total number of likes',
  labelNames: ['action'] as const, // 'like' or 'unlike'
  registers: [register],
});

export const likesDuplicateTotal: Counter<string> = new client.Counter({
  name: 'instagram_likes_duplicate_total',
  help: 'Total number of duplicate like attempts (idempotency)',
  registers: [register],
});

// Follows metrics
export const followsTotal: Counter<string> = new client.Counter({
  name: 'instagram_follows_total',
  help: 'Total number of follow operations',
  labelNames: ['action'] as const, // 'follow' or 'unfollow'
  registers: [register],
});

export const followsRateLimited: Counter<string> = new client.Counter({
  name: 'instagram_follows_rate_limited_total',
  help: 'Total number of follow operations blocked by rate limiter',
  registers: [register],
});

// Feed metrics
export const feedGenerationDuration: Histogram<string> = new client.Histogram({
  name: 'instagram_feed_generation_seconds',
  help: 'Duration of feed generation in seconds',
  labelNames: ['cache_status'] as const, // 'hit' or 'miss'
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const feedCacheHits: Counter<string> = new client.Counter({
  name: 'instagram_feed_cache_hits_total',
  help: 'Total number of feed cache hits',
  registers: [register],
});

export const feedCacheMisses: Counter<string> = new client.Counter({
  name: 'instagram_feed_cache_misses_total',
  help: 'Total number of feed cache misses',
  registers: [register],
});

// Image processing metrics
export const imageProcessingDuration: Histogram<string> = new client.Histogram({
  name: 'instagram_image_processing_seconds',
  help: 'Duration of image processing in seconds',
  labelNames: ['size'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const imageProcessingErrors: Counter<string> = new client.Counter({
  name: 'instagram_image_processing_errors_total',
  help: 'Total number of image processing errors',
  labelNames: ['error_type'] as const,
  registers: [register],
});

// Story metrics
export const storiesCreatedTotal: Counter<string> = new client.Counter({
  name: 'instagram_stories_created_total',
  help: 'Total number of stories created',
  registers: [register],
});

export const storyViewsTotal: Counter<string> = new client.Counter({
  name: 'instagram_story_views_total',
  help: 'Total number of story views',
  registers: [register],
});

// Session metrics
export const activeSessions: Gauge<string> = new client.Gauge({
  name: 'instagram_active_sessions',
  help: 'Number of active user sessions',
  registers: [register],
});

// Auth metrics
export const authAttempts: Counter<string> = new client.Counter({
  name: 'instagram_auth_attempts_total',
  help: 'Total number of authentication attempts',
  labelNames: ['type', 'result'] as const, // type: login/register, result: success/failure
  registers: [register],
});

// Rate limiting metrics
export const rateLimitHits: Counter<string> = new client.Counter({
  name: 'instagram_rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['action'] as const,
  registers: [register],
});

// Circuit breaker metrics
export const circuitBreakerState: Gauge<string> = new client.Gauge({
  name: 'instagram_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'] as const,
  registers: [register],
});

export const circuitBreakerEvents: Counter<string> = new client.Counter({
  name: 'instagram_circuit_breaker_events_total',
  help: 'Total circuit breaker events',
  labelNames: ['name', 'event'] as const, // event: success, failure, timeout, reject, open, close, halfOpen
  registers: [register],
});

// Database metrics
export const dbQueryDuration: Histogram<string> = new client.Histogram({
  name: 'instagram_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const dbConnectionPoolSize: Gauge<string> = new client.Gauge({
  name: 'instagram_db_connection_pool_size',
  help: 'Current database connection pool size',
  labelNames: ['state'] as const, // 'idle', 'total', 'waiting'
  registers: [register],
});

// Export the registry for /metrics endpoint
export { register };

interface ExtendedRequest extends Request {
  route?: { path?: string };
}

/**
 * Express middleware to track request metrics
 */
export const metricsMiddleware = (req: ExtendedRequest, res: Response, next: NextFunction): void => {
  const startTime = process.hrtime.bigint();

  // Track response
  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1e9; // Convert to seconds

    // Get route pattern for labels (use path pattern, not actual path)
    const route = req.route?.path || req.path || 'unknown';

    httpRequestDuration.labels(req.method, route, String(res.statusCode)).observe(duration);

    httpRequestsTotal.labels(req.method, route, String(res.statusCode)).inc();
  });

  next();
};

/**
 * Record a timed operation
 */
export const timedOperation = async <T>(
  histogram: Histogram<string>,
  labels: Record<string, string> | string,
  fn: () => Promise<T>
): Promise<T> => {
  const startTime = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1e9;
    if (typeof labels === 'object') {
      histogram.labels(labels).observe(duration);
    } else {
      histogram.observe(duration);
    }
  }
};

export default register;
