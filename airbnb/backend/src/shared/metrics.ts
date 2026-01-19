/**
 * Prometheus Metrics Module
 *
 * Exposes application metrics for:
 * - HTTP request latency and counts
 * - Business metrics (searches, bookings, availability checks)
 * - Cache hit/miss ratios
 * - Queue depths
 * - Circuit breaker states
 *
 * Metrics enable:
 * - Real-time monitoring and alerting
 * - Performance optimization (identify slow queries)
 * - Capacity planning (understand traffic patterns)
 * - Pricing optimization (correlate search patterns with conversions)
 */

import client from 'prom-client';

// Create a Registry
const register = new client.Registry();

// Enable default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({
  register,
  prefix: 'airbnb_',
});

// === HTTP Metrics ===

export const httpRequestDuration = new client.Histogram({
  name: 'airbnb_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: 'airbnb_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

// === Business Metrics ===

export const searchLatency = new client.Histogram({
  name: 'airbnb_search_latency_seconds',
  help: 'Search request latency in seconds',
  labelNames: ['has_dates', 'has_location', 'result_count_bucket'],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [register],
});

export const searchesTotal = new client.Counter({
  name: 'airbnb_searches_total',
  help: 'Total number of searches performed',
  labelNames: ['has_dates', 'has_location'],
  registers: [register],
});

export const bookingsTotal = new client.Counter({
  name: 'airbnb_bookings_total',
  help: 'Total number of bookings',
  labelNames: ['status', 'instant_book'],
  registers: [register],
});

export const bookingLatency = new client.Histogram({
  name: 'airbnb_booking_latency_seconds',
  help: 'Booking creation latency in seconds',
  labelNames: ['instant_book'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const availabilityChecksTotal = new client.Counter({
  name: 'airbnb_availability_checks_total',
  help: 'Total number of availability checks',
  labelNames: ['available'],
  registers: [register],
});

export const availabilityCheckLatency = new client.Histogram({
  name: 'airbnb_availability_check_latency_seconds',
  help: 'Availability check latency in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5],
  registers: [register],
});

// === Cache Metrics ===

export const cacheHits = new client.Counter({
  name: 'airbnb_cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: 'airbnb_cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheHitRatio = new client.Gauge({
  name: 'airbnb_cache_hit_ratio',
  help: 'Cache hit ratio by cache type',
  labelNames: ['cache_type'],
  registers: [register],
});

// === Queue Metrics ===

export const queueDepth = new client.Gauge({
  name: 'airbnb_queue_depth',
  help: 'Number of messages in queue',
  labelNames: ['queue_name'],
  registers: [register],
});

export const queueMessagesPublished = new client.Counter({
  name: 'airbnb_queue_messages_published_total',
  help: 'Total messages published to queue',
  labelNames: ['queue_name', 'event_type'],
  registers: [register],
});

export const queueMessagesConsumed = new client.Counter({
  name: 'airbnb_queue_messages_consumed_total',
  help: 'Total messages consumed from queue',
  labelNames: ['queue_name', 'event_type', 'status'],
  registers: [register],
});

export const queueMessageLatency = new client.Histogram({
  name: 'airbnb_queue_message_latency_seconds',
  help: 'Time from publish to consume for queue messages',
  labelNames: ['queue_name'],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
  registers: [register],
});

// === Circuit Breaker Metrics ===

export const circuitBreakerState = new client.Gauge({
  name: 'airbnb_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerFailures = new client.Counter({
  name: 'airbnb_circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerSuccesses = new client.Counter({
  name: 'airbnb_circuit_breaker_successes_total',
  help: 'Total circuit breaker successes',
  labelNames: ['service'],
  registers: [register],
});

// === Database Metrics ===

export const dbQueryDuration = new client.Histogram({
  name: 'airbnb_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

export const dbConnectionsActive = new client.Gauge({
  name: 'airbnb_db_connections_active',
  help: 'Number of active database connections',
  registers: [register],
});

// === Revenue/Business Intelligence Metrics ===

export const bookingRevenue = new client.Counter({
  name: 'airbnb_booking_revenue_total',
  help: 'Total booking revenue in cents',
  labelNames: ['property_type', 'city'],
  registers: [register],
});

export const bookingNights = new client.Counter({
  name: 'airbnb_booking_nights_total',
  help: 'Total booking nights',
  labelNames: ['property_type'],
  registers: [register],
});

// === Express Middleware ===

/**
 * Express middleware to track HTTP request metrics
 */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSeconds = durationNs / 1e9;

    const route = req.route?.path || req.path || 'unknown';
    const method = req.method;
    const status = res.statusCode;

    httpRequestDuration.observe({ method, route, status }, durationSeconds);
    httpRequestsTotal.inc({ method, route, status });
  });

  next();
}

// === Metrics Endpoint Handler ===

/**
 * Get all metrics for Prometheus scraping
 */
export async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for metrics response
 */
export function getMetricsContentType() {
  return register.contentType;
}

// Export all metrics as a single object for convenience
export const metrics = {
  httpRequestDuration,
  httpRequestsTotal,
  searchLatency,
  searchesTotal,
  bookingsTotal,
  bookingLatency,
  availabilityChecksTotal,
  availabilityCheckLatency,
  cacheHits,
  cacheMisses,
  cacheHitRatio,
  queueDepth,
  queueMessagesPublished,
  queueMessagesConsumed,
  queueMessageLatency,
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
  dbQueryDuration,
  dbConnectionsActive,
  bookingRevenue,
  bookingNights,
};

export default {
  metrics,
  metricsMiddleware,
  getMetrics,
  getMetricsContentType,
  register,
};
