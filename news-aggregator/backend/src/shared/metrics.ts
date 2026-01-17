/**
 * Prometheus metrics for observability.
 * Tracks key application metrics like request latency, article fetches,
 * feed generation, and cache hit rates.
 * @module shared/metrics
 */

import client from 'prom-client';

// Create a Registry for Prometheus metrics
const register = new client.Registry();

// Add default labels
register.setDefaultLabels({
  app: 'news-aggregator',
});

// Collect default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

/**
 * HTTP request duration histogram.
 * Tracks latency of API requests by method, route, and status code.
 */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/**
 * HTTP requests total counter.
 * Counts total requests by method, route, and status.
 */
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/**
 * Articles fetched counter.
 * Tracks total articles fetched from RSS sources.
 */
export const articlesFetchedTotal = new client.Counter({
  name: 'articles_fetched_total',
  help: 'Total number of articles fetched from sources',
  labelNames: ['source_id', 'status'],
  registers: [register],
});

/**
 * Articles stored counter.
 * Tracks new articles successfully stored in database.
 */
export const articlesStoredTotal = new client.Counter({
  name: 'articles_stored_total',
  help: 'Total number of new articles stored in database',
  registers: [register],
});

/**
 * Feed generations counter.
 * Tracks personalized feed generation requests.
 */
export const feedGenerationsTotal = new client.Counter({
  name: 'feed_generations_total',
  help: 'Total number of feed generation requests',
  labelNames: ['type', 'cached'],
  registers: [register],
});

/**
 * Feed generation duration histogram.
 * Tracks time to generate personalized feeds.
 */
export const feedGenerationDuration = new client.Histogram({
  name: 'feed_generation_duration_seconds',
  help: 'Duration of feed generation in seconds',
  labelNames: ['type', 'cached'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

/**
 * Cache hit counter.
 * Tracks cache hits by cache type.
 */
export const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'],
  registers: [register],
});

/**
 * Cache miss counter.
 * Tracks cache misses by cache type.
 */
export const cacheMissesTotal = new client.Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'],
  registers: [register],
});

/**
 * Crawler fetch counter.
 * Tracks RSS feed fetch attempts and outcomes.
 */
export const crawlerFetchTotal = new client.Counter({
  name: 'crawler_fetch_total',
  help: 'Total number of feed fetch attempts',
  labelNames: ['status'], // 'success', 'error', 'timeout', 'circuit_open'
  registers: [register],
});

/**
 * Crawler fetch duration histogram.
 * Tracks time to fetch RSS feeds.
 */
export const crawlerFetchDuration = new client.Histogram({
  name: 'crawler_fetch_duration_seconds',
  help: 'Duration of RSS feed fetches in seconds',
  labelNames: ['source_id'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

/**
 * Circuit breaker state gauge.
 * Tracks the current state of circuit breakers.
 * 0 = closed (healthy), 1 = open (failing), 2 = half-open (testing)
 */
export const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Current state of circuit breakers (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [register],
});

/**
 * Active crawl jobs gauge.
 * Tracks currently running crawl operations.
 */
export const activeCrawlJobs = new client.Gauge({
  name: 'active_crawl_jobs',
  help: 'Number of currently active crawl jobs',
  registers: [register],
});

/**
 * Index queue depth gauge.
 * Tracks number of articles pending indexing.
 */
export const indexQueueDepth = new client.Gauge({
  name: 'index_queue_depth',
  help: 'Number of articles pending Elasticsearch indexing',
  registers: [register],
});

/**
 * Database connection pool gauge.
 * Tracks active and idle connections.
 */
export const dbConnectionPool = new client.Gauge({
  name: 'db_connection_pool',
  help: 'Database connection pool statistics',
  labelNames: ['state'], // 'active', 'idle', 'waiting'
  registers: [register],
});

/**
 * Retry attempts counter.
 * Tracks retry attempts for failed operations.
 */
export const retryAttemptsTotal = new client.Counter({
  name: 'retry_attempts_total',
  help: 'Total number of retry attempts',
  labelNames: ['operation', 'attempt'],
  registers: [register],
});

/**
 * Get the Prometheus registry for exposing metrics.
 */
export function getMetricsRegistry(): client.Registry {
  return register;
}

/**
 * Get metrics as a string for the /metrics endpoint.
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get content type for metrics endpoint.
 */
export function getMetricsContentType(): string {
  return register.contentType;
}

/**
 * Express middleware for tracking HTTP request metrics.
 */
export function metricsMiddleware() {
  return (
    req: { method: string; path: string; route?: { path: string } },
    res: { statusCode: number; on: (event: string, cb: () => void) => void },
    next: () => void
  ) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationNs = Number(process.hrtime.bigint() - start);
      const durationSec = durationNs / 1e9;
      const route = req.route?.path || req.path;
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };

      httpRequestDuration.observe(labels, durationSec);
      httpRequestsTotal.inc(labels);
    });

    next();
  };
}
