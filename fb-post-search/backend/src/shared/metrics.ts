/**
 * @fileoverview Prometheus metrics for observability and alerting.
 * Provides counters, histograms, and gauges for search performance,
 * cache efficiency, and indexing lag monitoring.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Custom Prometheus registry for application metrics.
 * Separates application metrics from default Node.js metrics.
 */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop)
collectDefaultMetrics({ register: metricsRegistry });

// ============================================================================
// Search Metrics
// ============================================================================

/**
 * Counter for total search queries executed.
 * Labels: status (success/error), has_user (authenticated vs anonymous)
 */
export const searchQueriesTotal = new Counter({
  name: 'search_queries_total',
  help: 'Total number of search queries executed',
  labelNames: ['status', 'has_user'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for search query latency in seconds.
 * Buckets optimized for sub-second queries with p99 target of 200ms.
 */
export const searchLatencySeconds = new Histogram({
  name: 'search_latency_seconds',
  help: 'Search query latency in seconds',
  labelNames: ['status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

/**
 * Counter for search results returned.
 * Tracks zero-result searches separately for quality monitoring.
 */
export const searchResultsTotal = new Counter({
  name: 'search_results_total',
  help: 'Total number of search results returned',
  labelNames: ['has_results'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// Cache Metrics
// ============================================================================

/**
 * Counter for cache hits across different cache types.
 * Labels: cache_type (visibility, suggestions, session)
 */
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for cache misses across different cache types.
 * Labels: cache_type (visibility, suggestions, session)
 */
export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// Indexing Metrics
// ============================================================================

/**
 * Histogram for indexing lag in seconds.
 * Measures time from post creation to searchable in Elasticsearch.
 */
export const indexingLagSeconds = new Histogram({
  name: 'indexing_lag_seconds',
  help: 'Time between post creation and searchability in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

/**
 * Counter for posts indexed.
 * Labels: operation (create, update, delete)
 */
export const postsIndexedTotal = new Counter({
  name: 'posts_indexed_total',
  help: 'Total number of posts indexed in Elasticsearch',
  labelNames: ['operation'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge for current Elasticsearch index document count.
 * Updated periodically by health check or on-demand.
 */
export const elasticsearchDocsCount = new Gauge({
  name: 'elasticsearch_docs_count',
  help: 'Current number of documents in Elasticsearch index',
  registers: [metricsRegistry],
});

/**
 * Gauge for Elasticsearch index size in bytes.
 */
export const elasticsearchIndexSizeBytes = new Gauge({
  name: 'elasticsearch_index_size_bytes',
  help: 'Elasticsearch index size in bytes',
  registers: [metricsRegistry],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Counter for circuit breaker state transitions.
 * Labels: service (elasticsearch), state (open, closed, half_open)
 */
export const circuitBreakerStateTotal = new Counter({
  name: 'circuit_breaker_state_total',
  help: 'Circuit breaker state transitions',
  labelNames: ['service', 'state'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge for current circuit breaker state (0=closed, 1=open, 2=half_open).
 */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Current circuit breaker state (0=closed, 1=open, 2=half_open)',
  labelNames: ['service'] as const,
  registers: [metricsRegistry],
});

// ============================================================================
// Database Metrics
// ============================================================================

/**
 * Histogram for database query latency.
 * Labels: operation (select, insert, update, delete)
 */
export const dbQueryLatencySeconds = new Histogram({
  name: 'db_query_latency_seconds',
  help: 'Database query latency in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Gauge for active database connections.
 */
export const dbConnectionsActive = new Gauge({
  name: 'db_connections_active',
  help: 'Number of active database connections',
  registers: [metricsRegistry],
});

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/**
 * Counter for HTTP requests.
 * Labels: method, path, status_code
 */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for HTTP request duration.
 * Labels: method, path
 */
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Helper function to record search metrics.
 * @param durationSeconds - Query duration in seconds
 * @param status - 'success' or 'error'
 * @param hasUser - Whether the search was authenticated
 * @param resultsCount - Number of results returned
 */
export function recordSearchMetrics(
  durationSeconds: number,
  status: 'success' | 'error',
  hasUser: boolean,
  resultsCount: number
): void {
  searchQueriesTotal.inc({ status, has_user: String(hasUser) });
  searchLatencySeconds.observe({ status }, durationSeconds);
  searchResultsTotal.inc({ has_results: resultsCount > 0 ? 'true' : 'false' });
}

/**
 * Helper function to record cache access metrics.
 * @param cacheType - Type of cache (visibility, suggestions, session)
 * @param hit - Whether the access was a hit
 */
export function recordCacheAccess(cacheType: string, hit: boolean): void {
  if (hit) {
    cacheHitsTotal.inc({ cache_type: cacheType });
  } else {
    cacheMissesTotal.inc({ cache_type: cacheType });
  }
}

/**
 * Helper function to record indexing lag.
 * @param postCreatedAt - Post creation timestamp
 */
export function recordIndexingLag(postCreatedAt: Date): void {
  const lagSeconds = (Date.now() - postCreatedAt.getTime()) / 1000;
  indexingLagSeconds.observe(lagSeconds);
}
