import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { Pool } from 'pg';

/**
 * Prometheus Metrics Module
 *
 * Exposes metrics for:
 * - HTTP requests (method, path, status, duration)
 * - Business operations (searches, reviews, ratings)
 * - Cache operations (hits, misses)
 * - Database pool status
 * - Circuit breaker state
 */

// Create a Registry to hold all metrics
const register: Registry = new client.Registry();

// Add default Node.js metrics (memory, CPU, event loop, etc.)
client.collectDefaultMetrics({
  register,
  prefix: 'yelp_',
});

// ============================================================================
// HTTP Request Metrics
// ============================================================================

export const httpRequestDuration: Histogram<'method' | 'path' | 'status'> =
  new client.Histogram({
    name: 'yelp_http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'path', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

export const httpRequestsTotal: Counter<'method' | 'path' | 'status'> =
  new client.Counter({
    name: 'yelp_http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status'] as const,
    registers: [register],
  });

// ============================================================================
// Search Metrics
// ============================================================================

export const searchesTotal: Counter<'cache_hit' | 'has_geo' | 'has_category'> =
  new client.Counter({
    name: 'yelp_searches_total',
    help: 'Total number of search queries',
    labelNames: ['cache_hit', 'has_geo', 'has_category'] as const,
    registers: [register],
  });

export const searchDuration: Histogram<'cache_hit'> = new client.Histogram({
  name: 'yelp_search_duration_seconds',
  help: 'Duration of search queries in seconds',
  labelNames: ['cache_hit'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

export const searchResultsCount: Histogram<string> = new client.Histogram({
  name: 'yelp_search_results_count',
  help: 'Number of results returned per search',
  buckets: [0, 1, 5, 10, 20, 50, 100],
  registers: [register],
});

// ============================================================================
// Review Metrics
// ============================================================================

export const reviewsCreatedTotal: Counter<'rating'> = new client.Counter({
  name: 'yelp_reviews_created_total',
  help: 'Total number of reviews created',
  labelNames: ['rating'] as const,
  registers: [register],
});

export const reviewsRejectedTotal: Counter<'reason'> = new client.Counter({
  name: 'yelp_reviews_rejected_total',
  help: 'Total number of reviews rejected',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const ratingsDistribution: Counter<'rating'> = new client.Counter({
  name: 'yelp_ratings_distribution_total',
  help: 'Distribution of ratings submitted',
  labelNames: ['rating'] as const,
  registers: [register],
});

export const reviewVotesTotal: Counter<'vote_type'> = new client.Counter({
  name: 'yelp_review_votes_total',
  help: 'Total number of review votes',
  labelNames: ['vote_type'] as const,
  registers: [register],
});

// ============================================================================
// Cache Metrics
// ============================================================================

export const cacheOperationsTotal: Counter<'operation' | 'result'> =
  new client.Counter({
    name: 'yelp_cache_operations_total',
    help: 'Total number of cache operations',
    labelNames: ['operation', 'result'] as const,
    registers: [register],
  });

export const cacheHitRatio: Gauge<'cache_type'> = new client.Gauge({
  name: 'yelp_cache_hit_ratio',
  help: 'Cache hit ratio (rolling window)',
  labelNames: ['cache_type'] as const,
  registers: [register],
});

// ============================================================================
// Database Metrics
// ============================================================================

export const dbPoolConnections: Gauge<'state'> = new client.Gauge({
  name: 'yelp_db_pool_connections',
  help: 'Number of database pool connections',
  labelNames: ['state'] as const,
  registers: [register],
});

export const dbQueryDuration: Histogram<'operation' | 'table'> =
  new client.Histogram({
    name: 'yelp_db_query_duration_seconds',
    help: 'Duration of database queries in seconds',
    labelNames: ['operation', 'table'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
  });

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

export const circuitBreakerState: Gauge<'name'> = new client.Gauge({
  name: 'yelp_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'] as const,
  registers: [register],
});

export const circuitBreakerFailures: Counter<'name'> = new client.Counter({
  name: 'yelp_circuit_breaker_failures_total',
  help: 'Total failures recorded by circuit breaker',
  labelNames: ['name'] as const,
  registers: [register],
});

export const circuitBreakerSuccesses: Counter<'name'> = new client.Counter({
  name: 'yelp_circuit_breaker_successes_total',
  help: 'Total successes recorded by circuit breaker',
  labelNames: ['name'] as const,
  registers: [register],
});

// ============================================================================
// Business Metrics
// ============================================================================

export const businessesCreatedTotal: Counter<string> = new client.Counter({
  name: 'yelp_businesses_created_total',
  help: 'Total number of businesses created',
  registers: [register],
});

export const businessClaimsTotal: Counter<'status'> = new client.Counter({
  name: 'yelp_business_claims_total',
  help: 'Total number of business claims',
  labelNames: ['status'] as const,
  registers: [register],
});

// ============================================================================
// Rate Limiting Metrics
// ============================================================================

export const rateLimitedRequestsTotal: Counter<'endpoint' | 'limit_type'> =
  new client.Counter({
    name: 'yelp_rate_limited_requests_total',
    help: 'Total number of rate-limited requests',
    labelNames: ['endpoint', 'limit_type'] as const,
    registers: [register],
  });

// ============================================================================
// Idempotency Metrics
// ============================================================================

export const idempotentRequestsTotal: Counter<'action'> = new client.Counter({
  name: 'yelp_idempotent_requests_total',
  help: 'Total number of idempotent requests',
  labelNames: ['action'] as const,
  registers: [register],
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Record HTTP request metrics
 */
export function recordHttpRequest(
  method: string,
  path: string,
  status: number,
  durationSeconds: number
): void {
  // Normalize path to avoid high cardinality (replace UUIDs with :id)
  const normalizedPath = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );

  httpRequestDuration.observe(
    { method, path: normalizedPath, status: String(status) },
    durationSeconds
  );
  httpRequestsTotal.inc({ method, path: normalizedPath, status: String(status) });
}

/**
 * Record search metrics
 */
export function recordSearch(
  cacheHit: boolean,
  hasGeo: boolean,
  hasCategory: boolean,
  resultCount: number,
  durationSeconds: number
): void {
  searchesTotal.inc({
    cache_hit: cacheHit ? 'true' : 'false',
    has_geo: hasGeo ? 'true' : 'false',
    has_category: hasCategory ? 'true' : 'false',
  });
  searchDuration.observe(
    { cache_hit: cacheHit ? 'true' : 'false' },
    durationSeconds
  );
  searchResultsCount.observe(resultCount);
}

/**
 * Record review creation
 */
export function recordReviewCreated(rating: number): void {
  reviewsCreatedTotal.inc({ rating: String(rating) });
  ratingsDistribution.inc({ rating: String(rating) });
}

/**
 * Record review rejection
 */
export function recordReviewRejected(reason: string): void {
  reviewsRejectedTotal.inc({ reason });
}

/**
 * Record cache operation
 */
export function recordCacheOperation(operation: string, hit: boolean): void {
  cacheOperationsTotal.inc({
    operation,
    result: hit ? 'hit' : 'miss',
  });
}

/**
 * Update database pool metrics
 */
export function updateDbPoolMetrics(pool: Pool): void {
  dbPoolConnections.set({ state: 'total' }, pool.totalCount);
  dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
  dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
}

/**
 * Update circuit breaker state metric
 */
export function updateCircuitBreakerState(
  name: string,
  state: 'OPEN' | 'CLOSED' | 'HALF_OPEN'
): void {
  const stateValue = state === 'CLOSED' ? 0 : state === 'OPEN' ? 1 : 2;
  circuitBreakerState.set({ name }, stateValue);
}

/**
 * Get the metrics registry
 */
export function getRegistry(): Registry {
  return register;
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get content type for metrics endpoint
 */
export function getContentType(): string {
  return register.contentType;
}

export default {
  register,
  getMetrics,
  getContentType,
  recordHttpRequest,
  recordSearch,
  recordReviewCreated,
  recordReviewRejected,
  recordCacheOperation,
  updateDbPoolMetrics,
  updateCircuitBreakerState,
};
