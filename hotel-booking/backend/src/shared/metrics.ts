/**
 * Prometheus metrics for monitoring and alerting
 *
 * WHY: Metrics enable:
 * - Real-time visibility into system health
 * - SLO/SLA monitoring (latency, availability)
 * - Revenue optimization through booking funnel analysis
 * - Capacity planning based on usage patterns
 */

import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { Request, Response, NextFunction } from 'express';

// Create a Registry
export const register: Registry = new client.Registry();

// Add default metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register });

// ============================================
// HTTP Request Metrics
// ============================================

export const httpRequestsTotal: Counter<'method' | 'path' | 'status_code'> = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDurationSeconds: Histogram<'method' | 'path' | 'status_code'> = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'path', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// ============================================
// Business Metrics - Bookings
// ============================================

export const bookingsCreatedTotal: Counter<'status' | 'hotel_id'> = new client.Counter({
  name: 'bookings_created_total',
  help: 'Total number of bookings created',
  labelNames: ['status', 'hotel_id'] as const,
  registers: [register],
});

export const bookingsConfirmedTotal: Counter<'hotel_id'> = new client.Counter({
  name: 'bookings_confirmed_total',
  help: 'Total number of bookings confirmed (paid)',
  labelNames: ['hotel_id'] as const,
  registers: [register],
});

export const bookingsCancelledTotal: Counter<'hotel_id' | 'reason'> = new client.Counter({
  name: 'bookings_cancelled_total',
  help: 'Total number of bookings cancelled',
  labelNames: ['hotel_id', 'reason'] as const,
  registers: [register],
});

export const bookingsExpiredTotal: Counter<string> = new client.Counter({
  name: 'bookings_expired_total',
  help: 'Total number of reserved bookings that expired',
  registers: [register],
});

export const bookingRevenueTotal: Counter<'hotel_id' | 'room_type_id'> = new client.Counter({
  name: 'booking_revenue_total_cents',
  help: 'Total booking revenue in cents',
  labelNames: ['hotel_id', 'room_type_id'] as const,
  registers: [register],
});

export const bookingDurationSeconds: Histogram<string> = new client.Histogram({
  name: 'booking_creation_duration_seconds',
  help: 'Time to create a booking in seconds',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

// ============================================
// Business Metrics - Search
// ============================================

export const searchRequestsTotal: Counter<'has_dates' | 'city'> = new client.Counter({
  name: 'search_requests_total',
  help: 'Total number of search requests',
  labelNames: ['has_dates', 'city'] as const,
  registers: [register],
});

export const searchDurationSeconds: Histogram<string> = new client.Histogram({
  name: 'search_duration_seconds',
  help: 'Search request latency in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

export const searchResultsCount: Histogram<string> = new client.Histogram({
  name: 'search_results_count',
  help: 'Number of hotels returned in search results',
  buckets: [0, 1, 5, 10, 20, 50, 100],
  registers: [register],
});

// ============================================
// Business Metrics - Availability
// ============================================

export const availabilityChecksTotal: Counter<'cache_hit'> = new client.Counter({
  name: 'availability_checks_total',
  help: 'Total number of availability checks',
  labelNames: ['cache_hit'] as const,
  registers: [register],
});

export const availabilityCacheHitsTotal: Counter<string> = new client.Counter({
  name: 'availability_cache_hits_total',
  help: 'Total number of availability cache hits',
  registers: [register],
});

export const availabilityCacheMissesTotal: Counter<string> = new client.Counter({
  name: 'availability_cache_misses_total',
  help: 'Total number of availability cache misses',
  registers: [register],
});

// ============================================
// Infrastructure Metrics
// ============================================

export const dbPoolActiveConnections: Gauge<string> = new client.Gauge({
  name: 'db_pool_active_connections',
  help: 'Number of active database connections',
  registers: [register],
});

export const dbPoolIdleConnections: Gauge<string> = new client.Gauge({
  name: 'db_pool_idle_connections',
  help: 'Number of idle database connections',
  registers: [register],
});

export const redisConnectionStatus: Gauge<string> = new client.Gauge({
  name: 'redis_connection_status',
  help: 'Redis connection status (1 = connected, 0 = disconnected)',
  registers: [register],
});

export const elasticsearchConnectionStatus: Gauge<string> = new client.Gauge({
  name: 'elasticsearch_connection_status',
  help: 'Elasticsearch connection status (1 = connected, 0 = disconnected)',
  registers: [register],
});

// ============================================
// Circuit Breaker Metrics
// ============================================

export const circuitBreakerState: Gauge<'service'> = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0 = closed, 1 = half-open, 2 = open)',
  labelNames: ['service'] as const,
  registers: [register],
});

export const circuitBreakerFailuresTotal: Counter<'service'> = new client.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total number of circuit breaker failures',
  labelNames: ['service'] as const,
  registers: [register],
});

// ============================================
// Distributed Lock Metrics
// ============================================

export const distributedLockAcquisitionsTotal: Counter<'resource' | 'success'> = new client.Counter({
  name: 'distributed_lock_acquisitions_total',
  help: 'Total number of distributed lock acquisitions',
  labelNames: ['resource', 'success'] as const,
  registers: [register],
});

export const distributedLockWaitSeconds: Histogram<'resource'> = new client.Histogram({
  name: 'distributed_lock_wait_seconds',
  help: 'Time waiting to acquire a distributed lock',
  labelNames: ['resource'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

// ============================================
// Idempotency Metrics
// ============================================

export const idempotentRequestsTotal: Counter<'deduplicated'> = new client.Counter({
  name: 'idempotent_requests_total',
  help: 'Total number of idempotent requests',
  labelNames: ['deduplicated'] as const,
  registers: [register],
});

// ============================================
// Express Middleware
// ============================================

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const durationSeconds = (Date.now() - startTime) / 1000;

    // Normalize path to avoid high cardinality
    const path = normalizePath(req.route?.path || req.path);

    httpRequestsTotal.inc({
      method: req.method,
      path,
      status_code: res.statusCode.toString(),
    });

    httpRequestDurationSeconds.observe(
      {
        method: req.method,
        path,
        status_code: res.statusCode.toString(),
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
function normalizePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
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
