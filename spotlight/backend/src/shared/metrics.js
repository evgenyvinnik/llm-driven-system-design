import client from 'prom-client';

// Create a Registry to register the metrics
const register = new client.Registry();

// Add default labels to all metrics
register.setDefaultLabels({
  service: 'spotlight'
});

// Enable collection of default metrics (memory, CPU, etc.)
client.collectDefaultMetrics({ register });

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/**
 * HTTP request duration histogram
 * Labels: method, route, status_code
 */
export const httpRequestDuration = new client.Histogram({
  name: 'spotlight_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});
register.registerMetric(httpRequestDuration);

/**
 * HTTP requests total counter
 * Labels: method, route, status_code
 */
export const httpRequestsTotal = new client.Counter({
  name: 'spotlight_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});
register.registerMetric(httpRequestsTotal);

// ============================================================================
// Search Metrics
// ============================================================================

/**
 * Search latency histogram by source
 * Labels: source (local, provider, cloud, all)
 */
export const searchLatency = new client.Histogram({
  name: 'spotlight_search_latency_seconds',
  help: 'Search query latency in seconds',
  labelNames: ['source'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
});
register.registerMetric(searchLatency);

/**
 * Search result count histogram
 */
export const searchResultCount = new client.Histogram({
  name: 'spotlight_search_result_count',
  help: 'Number of results returned per search',
  buckets: [0, 1, 5, 10, 20, 50, 100]
});
register.registerMetric(searchResultCount);

/**
 * Search requests total by query type
 * Labels: type (search, math, conversion, date_filter)
 */
export const searchRequestsTotal = new client.Counter({
  name: 'spotlight_search_requests_total',
  help: 'Total number of search requests by query type',
  labelNames: ['type']
});
register.registerMetric(searchRequestsTotal);

// ============================================================================
// Index Operation Metrics
// ============================================================================

/**
 * Index operation latency histogram
 * Labels: operation (add, update, delete, bulk), document_type (file, app, contact, web)
 */
export const indexOperationLatency = new client.Histogram({
  name: 'spotlight_index_operation_latency_seconds',
  help: 'Index operation latency in seconds',
  labelNames: ['operation', 'document_type'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});
register.registerMetric(indexOperationLatency);

/**
 * Index operations total counter
 * Labels: operation, document_type, status (success, error, skipped, idempotent_hit)
 */
export const indexOperationsTotal = new client.Counter({
  name: 'spotlight_index_operations_total',
  help: 'Total number of index operations',
  labelNames: ['operation', 'document_type', 'status']
});
register.registerMetric(indexOperationsTotal);

/**
 * Indexing queue size gauge
 */
export const indexingQueueSize = new client.Gauge({
  name: 'spotlight_indexing_queue_size',
  help: 'Number of files pending indexing'
});
register.registerMetric(indexingQueueSize);

/**
 * Index size in bytes gauge
 */
export const indexSizeBytes = new client.Gauge({
  name: 'spotlight_index_size_bytes',
  help: 'Size of the search index in bytes',
  labelNames: ['index_name']
});
register.registerMetric(indexSizeBytes);

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Circuit breaker state gauge
 * Labels: name
 * Values: 0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN
 */
export const circuitBreakerState = new client.Gauge({
  name: 'spotlight_circuit_breaker_state',
  help: 'Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
  labelNames: ['name']
});
register.registerMetric(circuitBreakerState);

/**
 * Circuit breaker trips total counter
 * Labels: name
 */
export const circuitBreakerTripsTotal = new client.Counter({
  name: 'spotlight_circuit_breaker_trips_total',
  help: 'Total number of circuit breaker trips (opens)',
  labelNames: ['name']
});
register.registerMetric(circuitBreakerTripsTotal);

// ============================================================================
// Rate Limiting Metrics
// ============================================================================

/**
 * Rate limit hits total counter
 * Labels: route
 */
export const rateLimitHitsTotal = new client.Counter({
  name: 'spotlight_rate_limit_hits_total',
  help: 'Total number of rate limit hits (rejected requests)',
  labelNames: ['route']
});
register.registerMetric(rateLimitHitsTotal);

// ============================================================================
// Idempotency Metrics
// ============================================================================

/**
 * Idempotency cache hits total counter
 * Labels: operation
 */
export const idempotencyCacheHitsTotal = new client.Counter({
  name: 'spotlight_idempotency_cache_hits_total',
  help: 'Total number of idempotency cache hits (duplicate requests)',
  labelNames: ['operation']
});
register.registerMetric(idempotencyCacheHitsTotal);

// ============================================================================
// Health Check Metrics
// ============================================================================

/**
 * Service health gauge
 * Labels: component (postgres, elasticsearch, redis)
 * Values: 0 = unhealthy, 1 = healthy
 */
export const serviceHealth = new client.Gauge({
  name: 'spotlight_service_health',
  help: 'Health status of service dependencies (0=unhealthy, 1=healthy)',
  labelNames: ['component']
});
register.registerMetric(serviceHealth);

// ============================================================================
// Middleware Functions
// ============================================================================

/**
 * Express middleware to track HTTP request metrics
 */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSeconds = durationNs / 1e9;

    // Normalize route path to avoid high cardinality
    const route = normalizeRoute(req.route?.path || req.path);

    httpRequestDuration.labels(req.method, route, res.statusCode.toString()).observe(durationSeconds);
    httpRequestsTotal.labels(req.method, route, res.statusCode.toString()).inc();
  });

  next();
}

/**
 * Normalize route path to avoid high cardinality in metrics
 */
function normalizeRoute(path) {
  // Replace dynamic segments with placeholders
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[^/]+\.[^/]+$/g, '/:filename');
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for Prometheus metrics
 */
export function getContentType() {
  return register.contentType;
}

export { register };
export default {
  httpRequestDuration,
  httpRequestsTotal,
  searchLatency,
  searchResultCount,
  searchRequestsTotal,
  indexOperationLatency,
  indexOperationsTotal,
  indexingQueueSize,
  indexSizeBytes,
  circuitBreakerState,
  circuitBreakerTripsTotal,
  rateLimitHitsTotal,
  idempotencyCacheHitsTotal,
  serviceHealth,
  metricsMiddleware,
  getMetrics,
  getContentType
};
