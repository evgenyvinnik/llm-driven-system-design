/**
 * Prometheus metrics for monitoring and alerting
 *
 * WHY: Metrics enable:
 * - Real-time visibility into system health
 * - SLO/SLA monitoring (latency, availability)
 * - Revenue optimization through booking funnel analysis
 * - Capacity planning based on usage patterns
 */

const client = require('prom-client');

// Create a Registry
const register = new client.Registry();

// Add default metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register });

// ============================================
// HTTP Request Metrics
// ============================================

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
  registers: [register],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'path', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// ============================================
// Business Metrics - Bookings
// ============================================

const bookingsCreatedTotal = new client.Counter({
  name: 'bookings_created_total',
  help: 'Total number of bookings created',
  labelNames: ['status', 'hotel_id'],
  registers: [register],
});

const bookingsConfirmedTotal = new client.Counter({
  name: 'bookings_confirmed_total',
  help: 'Total number of bookings confirmed (paid)',
  labelNames: ['hotel_id'],
  registers: [register],
});

const bookingsCancelledTotal = new client.Counter({
  name: 'bookings_cancelled_total',
  help: 'Total number of bookings cancelled',
  labelNames: ['hotel_id', 'reason'],
  registers: [register],
});

const bookingsExpiredTotal = new client.Counter({
  name: 'bookings_expired_total',
  help: 'Total number of reserved bookings that expired',
  registers: [register],
});

const bookingRevenueTotal = new client.Counter({
  name: 'booking_revenue_total_cents',
  help: 'Total booking revenue in cents',
  labelNames: ['hotel_id', 'room_type_id'],
  registers: [register],
});

const bookingDurationSeconds = new client.Histogram({
  name: 'booking_creation_duration_seconds',
  help: 'Time to create a booking in seconds',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// ============================================
// Business Metrics - Search
// ============================================

const searchRequestsTotal = new client.Counter({
  name: 'search_requests_total',
  help: 'Total number of search requests',
  labelNames: ['has_dates', 'city'],
  registers: [register],
});

const searchDurationSeconds = new client.Histogram({
  name: 'search_duration_seconds',
  help: 'Search request latency in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

const searchResultsCount = new client.Histogram({
  name: 'search_results_count',
  help: 'Number of hotels returned in search results',
  buckets: [0, 1, 5, 10, 20, 50, 100],
  registers: [register],
});

// ============================================
// Business Metrics - Availability
// ============================================

const availabilityChecksTotal = new client.Counter({
  name: 'availability_checks_total',
  help: 'Total number of availability checks',
  labelNames: ['cache_hit'],
  registers: [register],
});

const availabilityCacheHitsTotal = new client.Counter({
  name: 'availability_cache_hits_total',
  help: 'Total number of availability cache hits',
  registers: [register],
});

const availabilityCacheMissesTotal = new client.Counter({
  name: 'availability_cache_misses_total',
  help: 'Total number of availability cache misses',
  registers: [register],
});

// ============================================
// Infrastructure Metrics
// ============================================

const dbPoolActiveConnections = new client.Gauge({
  name: 'db_pool_active_connections',
  help: 'Number of active database connections',
  registers: [register],
});

const dbPoolIdleConnections = new client.Gauge({
  name: 'db_pool_idle_connections',
  help: 'Number of idle database connections',
  registers: [register],
});

const redisConnectionStatus = new client.Gauge({
  name: 'redis_connection_status',
  help: 'Redis connection status (1 = connected, 0 = disconnected)',
  registers: [register],
});

const elasticsearchConnectionStatus = new client.Gauge({
  name: 'elasticsearch_connection_status',
  help: 'Elasticsearch connection status (1 = connected, 0 = disconnected)',
  registers: [register],
});

// ============================================
// Circuit Breaker Metrics
// ============================================

const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0 = closed, 1 = half-open, 2 = open)',
  labelNames: ['service'],
  registers: [register],
});

const circuitBreakerFailuresTotal = new client.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total number of circuit breaker failures',
  labelNames: ['service'],
  registers: [register],
});

// ============================================
// Distributed Lock Metrics
// ============================================

const distributedLockAcquisitionsTotal = new client.Counter({
  name: 'distributed_lock_acquisitions_total',
  help: 'Total number of distributed lock acquisitions',
  labelNames: ['resource', 'success'],
  registers: [register],
});

const distributedLockWaitSeconds = new client.Histogram({
  name: 'distributed_lock_wait_seconds',
  help: 'Time waiting to acquire a distributed lock',
  labelNames: ['resource'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

// ============================================
// Idempotency Metrics
// ============================================

const idempotentRequestsTotal = new client.Counter({
  name: 'idempotent_requests_total',
  help: 'Total number of idempotent requests',
  labelNames: ['deduplicated'],
  registers: [register],
});

// ============================================
// Express Middleware
// ============================================

function metricsMiddleware(req, res, next) {
  const startTime = Date.now();

  res.on('finish', () => {
    const durationSeconds = (Date.now() - startTime) / 1000;

    // Normalize path to avoid high cardinality
    const path = normalizePath(req.route?.path || req.path);

    httpRequestsTotal.inc({
      method: req.method,
      path,
      status_code: res.statusCode,
    });

    httpRequestDurationSeconds.observe(
      {
        method: req.method,
        path,
        status_code: res.statusCode,
      },
      durationSeconds
    );
  });

  next();
}

/**
 * Normalize path to avoid high cardinality from dynamic segments
 * e.g., /bookings/abc-123 -> /bookings/:id
 */
function normalizePath(path) {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/**
 * Get metrics in Prometheus format
 */
async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for metrics endpoint
 */
function getContentType() {
  return register.contentType;
}

module.exports = {
  register,
  // HTTP
  httpRequestsTotal,
  httpRequestDurationSeconds,
  metricsMiddleware,
  getMetrics,
  getContentType,
  // Business - Bookings
  bookingsCreatedTotal,
  bookingsConfirmedTotal,
  bookingsCancelledTotal,
  bookingsExpiredTotal,
  bookingRevenueTotal,
  bookingDurationSeconds,
  // Business - Search
  searchRequestsTotal,
  searchDurationSeconds,
  searchResultsCount,
  // Business - Availability
  availabilityChecksTotal,
  availabilityCacheHitsTotal,
  availabilityCacheMissesTotal,
  // Infrastructure
  dbPoolActiveConnections,
  dbPoolIdleConnections,
  redisConnectionStatus,
  elasticsearchConnectionStatus,
  // Circuit Breaker
  circuitBreakerState,
  circuitBreakerFailuresTotal,
  // Distributed Lock
  distributedLockAcquisitionsTotal,
  distributedLockWaitSeconds,
  // Idempotency
  idempotentRequestsTotal,
};
