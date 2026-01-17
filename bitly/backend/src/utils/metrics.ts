/**
 * Prometheus metrics module.
 * Exposes application metrics for monitoring URL shortening operations,
 * redirect performance, cache efficiency, and key pool health.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics registry.
 * Contains all application-specific and default Node.js metrics.
 */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * HTTP request counter.
 * Tracks total requests by method, endpoint, and status code.
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'endpoint', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * HTTP request duration histogram.
 * Measures request latency in seconds with p50, p90, p99 buckets.
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'endpoint'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/**
 * URL shortening counter.
 * Tracks URL creation attempts by status (success, error, duplicate).
 */
export const urlShorteningTotal = new Counter({
  name: 'url_shortening_total',
  help: 'Total number of URL shortening operations',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

/**
 * URL redirect counter.
 * Tracks redirects with cache hit/miss information.
 */
export const urlRedirectsTotal = new Counter({
  name: 'url_redirects_total',
  help: 'Total number of URL redirects',
  labelNames: ['cached', 'status'] as const,
  registers: [metricsRegistry],
});

/**
 * Click analytics counter.
 * Tracks click events recorded for analytics by device type.
 */
export const clickEventsTotal = new Counter({
  name: 'click_events_total',
  help: 'Total number of click events recorded',
  labelNames: ['device_type'] as const,
  registers: [metricsRegistry],
});

/**
 * Cache hits counter.
 * Tracks successful cache lookups for URL short codes.
 */
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  registers: [metricsRegistry],
});

/**
 * Cache misses counter.
 * Tracks failed cache lookups requiring database queries.
 */
export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  registers: [metricsRegistry],
});

/**
 * Key pool available gauge.
 * Current number of unused short codes available for allocation.
 */
export const keyPoolAvailable = new Gauge({
  name: 'key_pool_available',
  help: 'Number of available keys in the pool',
  registers: [metricsRegistry],
});

/**
 * Local key cache gauge.
 * Number of keys cached locally on this server instance.
 */
export const localKeyCacheCount = new Gauge({
  name: 'local_key_cache_count',
  help: 'Number of keys in local server cache',
  registers: [metricsRegistry],
});

/**
 * Active database connections gauge.
 * Current number of active database pool connections.
 */
export const dbConnectionsActive = new Gauge({
  name: 'db_connections_active',
  help: 'Number of active database connections',
  registers: [metricsRegistry],
});

/**
 * Database query duration histogram.
 * Measures database query latency for performance monitoring.
 */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Circuit breaker state gauge.
 * Tracks circuit breaker state: 0=closed, 1=open, 0.5=half-open.
 */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
  labelNames: ['name'] as const,
  registers: [metricsRegistry],
});

/**
 * Rate limit hits counter.
 * Tracks how often rate limits are triggered.
 */
export const rateLimitHitsTotal = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['endpoint'] as const,
  registers: [metricsRegistry],
});

/**
 * Idempotency cache hits counter.
 * Tracks duplicate request detection for URL creation.
 */
export const idempotencyHitsTotal = new Counter({
  name: 'idempotency_hits_total',
  help: 'Total number of idempotency key cache hits (duplicate requests)',
  registers: [metricsRegistry],
});
