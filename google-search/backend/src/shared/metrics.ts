import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';

/**
 * Prometheus Metrics Module
 *
 * WHY query metrics enable ranking optimization:
 * - Track which queries are slow (optimize index or caching)
 * - Monitor cache hit rates (adjust TTL)
 * - Measure result counts (detect zero-result queries for index gaps)
 * - Identify popular queries (pre-warm cache, prioritize crawls)
 */

// Create a custom registry
const register = new client.Registry();

// Add default labels
register.setDefaultLabels({
  service: 'google-search-backend',
  instance: process.env.HOSTNAME || 'local',
});

// Collect default metrics (memory, CPU, event loop)
client.collectDefaultMetrics({ register });

// ============================================
// QUERY METRICS
// ============================================

/**
 * Query latency histogram - track search response times
 * Buckets designed for <200ms SLA with visibility into slow queries
 */
export const queryLatencyHistogram = new client.Histogram({
  name: 'search_query_latency_seconds',
  help: 'End-to-end query latency in seconds',
  labelNames: ['cache_hit', 'result_bucket'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

/**
 * Query counter - total queries processed
 */
export const queryCounter = new client.Counter({
  name: 'search_queries_total',
  help: 'Total number of search queries',
  labelNames: ['status'],
  registers: [register],
});

/**
 * Query result count histogram - track result counts
 */
export const queryResultsHistogram = new client.Histogram({
  name: 'search_query_results_count',
  help: 'Number of results returned per query',
  labelNames: ['cache_hit'],
  buckets: [0, 1, 5, 10, 50, 100, 500, 1000],
  registers: [register],
});

/**
 * Cache hit ratio gauge - current cache effectiveness
 */
export const cacheHitRatioGauge = new client.Gauge({
  name: 'search_cache_hit_ratio',
  help: 'Rolling cache hit ratio (last 5 minutes)',
  registers: [register],
});

// Track hits/misses for ratio calculation
let cacheHits = 0;
let cacheMisses = 0;

export const recordCacheHit = (): void => {
  cacheHits++;
};

export const recordCacheMiss = (): void => {
  cacheMisses++;
};

// Update cache ratio every 30 seconds
setInterval(() => {
  const total = cacheHits + cacheMisses;
  if (total > 0) {
    cacheHitRatioGauge.set(cacheHits / total);
  }
  // Reset counters for rolling window
  cacheHits = 0;
  cacheMisses = 0;
}, 30000);

// ============================================
// INDEX METRICS
// ============================================

/**
 * Index operation counter
 */
export const indexOperationsCounter = new client.Counter({
  name: 'search_index_operations_total',
  help: 'Total index operations',
  labelNames: ['operation', 'status'],
  registers: [register],
});

/**
 * Index operation latency
 */
export const indexLatencyHistogram = new client.Histogram({
  name: 'search_index_latency_seconds',
  help: 'Index operation latency in seconds',
  labelNames: ['operation'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

/**
 * Documents indexed gauge - current index size
 */
export const documentsIndexedGauge = new client.Gauge({
  name: 'search_documents_indexed',
  help: 'Current number of documents in index',
  registers: [register],
});

/**
 * Index size in bytes
 */
export const indexSizeBytesGauge = new client.Gauge({
  name: 'search_index_size_bytes',
  help: 'Current size of search index in bytes',
  registers: [register],
});

// ============================================
// CRAWL METRICS
// ============================================

/**
 * URLs crawled counter
 */
export const crawlCounter = new client.Counter({
  name: 'search_crawl_urls_total',
  help: 'Total URLs crawled',
  labelNames: ['status_code', 'content_type'],
  registers: [register],
});

/**
 * Crawl latency
 */
export const crawlLatencyHistogram = new client.Histogram({
  name: 'search_crawl_latency_seconds',
  help: 'Time to fetch and process a URL',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

/**
 * Frontier size gauge
 */
export const frontierSizeGauge = new client.Gauge({
  name: 'search_crawl_frontier_size',
  help: 'Number of URLs waiting in frontier',
  registers: [register],
});

/**
 * Crawl errors counter
 */
export const crawlErrorsCounter = new client.Counter({
  name: 'search_crawl_errors_total',
  help: 'Crawl failures by error type',
  labelNames: ['error_type'],
  registers: [register],
});

// ============================================
// CIRCUIT BREAKER METRICS
// ============================================

/**
 * Circuit breaker state gauge
 * 0 = CLOSED (healthy), 1 = HALF_OPEN (testing), 2 = OPEN (failing)
 */
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'search_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half_open, 2=open)',
  labelNames: ['service'],
  registers: [register],
});

/**
 * Circuit breaker trips counter
 */
export const circuitBreakerTripsCounter = new client.Counter({
  name: 'search_circuit_breaker_trips_total',
  help: 'Number of times circuit breaker has tripped',
  labelNames: ['service'],
  registers: [register],
});

// ============================================
// RATE LIMITER METRICS
// ============================================

/**
 * Rate limit rejections counter
 */
export const rateLimitRejectionsCounter = new client.Counter({
  name: 'search_rate_limit_rejections_total',
  help: 'Number of requests rejected by rate limiter',
  labelNames: ['endpoint'],
  registers: [register],
});

// ============================================
// EXPRESS MIDDLEWARE
// ============================================

/**
 * Metrics endpoint handler for Prometheus scraping
 */
export const metricsHandler = async (_req: Request, res: Response): Promise<void> => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
};

/**
 * HTTP request duration middleware
 */
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [register],
});

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';

    httpRequestDuration
      .labels(req.method, route, res.statusCode.toString())
      .observe(duration);
  });

  next();
};

export { register };
