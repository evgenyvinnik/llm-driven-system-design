import client from 'prom-client';

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
const register = new client.Registry();

// Add default Node.js metrics (memory, CPU, event loop, etc.)
client.collectDefaultMetrics({
  register,
  prefix: 'yelp_',
});

// ============================================================================
// HTTP Request Metrics
// ============================================================================

export const httpRequestDuration = new client.Histogram({
  name: 'yelp_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'yelp_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

// ============================================================================
// Search Metrics
// ============================================================================

export const searchesTotal = new client.Counter({
  name: 'yelp_searches_total',
  help: 'Total number of search queries',
  labelNames: ['cache_hit', 'has_geo', 'has_category'],
  registers: [register],
});

export const searchDuration = new client.Histogram({
  name: 'yelp_search_duration_seconds',
  help: 'Duration of search queries in seconds',
  labelNames: ['cache_hit'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

export const searchResultsCount = new client.Histogram({
  name: 'yelp_search_results_count',
  help: 'Number of results returned per search',
  buckets: [0, 1, 5, 10, 20, 50, 100],
  registers: [register],
});

// ============================================================================
// Review Metrics
// ============================================================================

export const reviewsCreatedTotal = new client.Counter({
  name: 'yelp_reviews_created_total',
  help: 'Total number of reviews created',
  labelNames: ['rating'],
  registers: [register],
});

export const reviewsRejectedTotal = new client.Counter({
  name: 'yelp_reviews_rejected_total',
  help: 'Total number of reviews rejected',
  labelNames: ['reason'],
  registers: [register],
});

export const ratingsDistribution = new client.Counter({
  name: 'yelp_ratings_distribution_total',
  help: 'Distribution of ratings submitted',
  labelNames: ['rating'],
  registers: [register],
});

export const reviewVotesTotal = new client.Counter({
  name: 'yelp_review_votes_total',
  help: 'Total number of review votes',
  labelNames: ['vote_type'],
  registers: [register],
});

// ============================================================================
// Cache Metrics
// ============================================================================

export const cacheOperationsTotal = new client.Counter({
  name: 'yelp_cache_operations_total',
  help: 'Total number of cache operations',
  labelNames: ['operation', 'result'],
  registers: [register],
});

export const cacheHitRatio = new client.Gauge({
  name: 'yelp_cache_hit_ratio',
  help: 'Cache hit ratio (rolling window)',
  labelNames: ['cache_type'],
  registers: [register],
});

// ============================================================================
// Database Metrics
// ============================================================================

export const dbPoolConnections = new client.Gauge({
  name: 'yelp_db_pool_connections',
  help: 'Number of database pool connections',
  labelNames: ['state'],
  registers: [register],
});

export const dbQueryDuration = new client.Histogram({
  name: 'yelp_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

export const circuitBreakerState = new client.Gauge({
  name: 'yelp_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [register],
});

export const circuitBreakerFailures = new client.Counter({
  name: 'yelp_circuit_breaker_failures_total',
  help: 'Total failures recorded by circuit breaker',
  labelNames: ['name'],
  registers: [register],
});

export const circuitBreakerSuccesses = new client.Counter({
  name: 'yelp_circuit_breaker_successes_total',
  help: 'Total successes recorded by circuit breaker',
  labelNames: ['name'],
  registers: [register],
});

// ============================================================================
// Business Metrics
// ============================================================================

export const businessesCreatedTotal = new client.Counter({
  name: 'yelp_businesses_created_total',
  help: 'Total number of businesses created',
  registers: [register],
});

export const businessClaimsTotal = new client.Counter({
  name: 'yelp_business_claims_total',
  help: 'Total number of business claims',
  labelNames: ['status'],
  registers: [register],
});

// ============================================================================
// Rate Limiting Metrics
// ============================================================================

export const rateLimitedRequestsTotal = new client.Counter({
  name: 'yelp_rate_limited_requests_total',
  help: 'Total number of rate-limited requests',
  labelNames: ['endpoint', 'limit_type'],
  registers: [register],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

export const idempotentRequestsTotal = new client.Counter({
  name: 'yelp_idempotent_requests_total',
  help: 'Total number of idempotent requests',
  labelNames: ['action'],
  registers: [register],
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Record HTTP request metrics
 */
export function recordHttpRequest(method, path, status, durationSeconds) {
  // Normalize path to avoid high cardinality (replace UUIDs with :id)
  const normalizedPath = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );

  httpRequestDuration.observe({ method, path: normalizedPath, status }, durationSeconds);
  httpRequestsTotal.inc({ method, path: normalizedPath, status });
}

/**
 * Record search metrics
 */
export function recordSearch(cacheHit, hasGeo, hasCategory, resultCount, durationSeconds) {
  searchesTotal.inc({
    cache_hit: cacheHit ? 'true' : 'false',
    has_geo: hasGeo ? 'true' : 'false',
    has_category: hasCategory ? 'true' : 'false',
  });
  searchDuration.observe({ cache_hit: cacheHit ? 'true' : 'false' }, durationSeconds);
  searchResultsCount.observe(resultCount);
}

/**
 * Record review creation
 */
export function recordReviewCreated(rating) {
  reviewsCreatedTotal.inc({ rating: String(rating) });
  ratingsDistribution.inc({ rating: String(rating) });
}

/**
 * Record review rejection
 */
export function recordReviewRejected(reason) {
  reviewsRejectedTotal.inc({ reason });
}

/**
 * Record cache operation
 */
export function recordCacheOperation(operation, hit) {
  cacheOperationsTotal.inc({
    operation,
    result: hit ? 'hit' : 'miss',
  });
}

/**
 * Update database pool metrics
 */
export function updateDbPoolMetrics(pool) {
  dbPoolConnections.set({ state: 'total' }, pool.totalCount);
  dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
  dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
}

/**
 * Update circuit breaker state metric
 */
export function updateCircuitBreakerState(name, state) {
  const stateValue = state === 'CLOSED' ? 0 : state === 'OPEN' ? 1 : 2;
  circuitBreakerState.set({ name }, stateValue);
}

/**
 * Get the metrics registry
 */
export function getRegistry() {
  return register;
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for metrics endpoint
 */
export function getContentType() {
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
