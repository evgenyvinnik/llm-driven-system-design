import client, {
  Counter,
  Histogram,
  Gauge,
  Registry,
} from 'prom-client';

/**
 * Custom Prometheus registry for Calendly metrics.
 * Separates application metrics from default Node.js metrics.
 */
export const register = new Registry();

// Add default Node.js metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// ============================================================================
// BOOKING METRICS
// ============================================================================

/**
 * Counter for total booking operations.
 * Tracks creation, cancellation, and rescheduling events.
 */
export const bookingOperationsTotal = new Counter({
  name: 'calendly_booking_operations_total',
  help: 'Total number of booking operations',
  labelNames: ['operation', 'status'] as const,
  registers: [register],
});

/**
 * Histogram for booking creation duration.
 * Measures latency from request to database commit.
 * Buckets optimized for typical booking latencies (10ms to 2s).
 */
export const bookingCreationDuration = new Histogram({
  name: 'calendly_booking_creation_duration_seconds',
  help: 'Duration of booking creation in seconds',
  labelNames: ['status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

/**
 * Gauge for active bookings count.
 * Useful for capacity planning and monitoring.
 */
export const activeBookingsGauge = new Gauge({
  name: 'calendly_active_bookings',
  help: 'Current number of confirmed upcoming bookings',
  registers: [register],
});

/**
 * Counter for double-booking prevention events.
 * Should remain at zero under normal operation.
 */
export const doubleBookingPrevented = new Counter({
  name: 'calendly_double_booking_prevented_total',
  help: 'Total number of double-booking attempts prevented',
  registers: [register],
});

// ============================================================================
// AVAILABILITY METRICS
// ============================================================================

/**
 * Counter for availability check requests.
 * Tracks slot calculation operations.
 */
export const availabilityChecksTotal = new Counter({
  name: 'calendly_availability_checks_total',
  help: 'Total number of availability checks',
  labelNames: ['cache_hit'] as const,
  registers: [register],
});

/**
 * Histogram for availability calculation duration.
 * Measures time to compute available slots.
 */
export const availabilityCalculationDuration = new Histogram({
  name: 'calendly_availability_calculation_duration_seconds',
  help: 'Duration of availability calculation in seconds',
  labelNames: ['cache_hit'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
  registers: [register],
});

// ============================================================================
// CALENDAR SYNC METRICS
// ============================================================================

/**
 * Counter for calendar sync operations.
 * Tracks external calendar API interactions.
 */
export const calendarSyncTotal = new Counter({
  name: 'calendly_calendar_sync_total',
  help: 'Total number of calendar sync operations',
  labelNames: ['provider', 'status'] as const,
  registers: [register],
});

/**
 * Histogram for calendar sync duration.
 * Measures time spent syncing with external calendar APIs.
 */
export const calendarSyncDuration = new Histogram({
  name: 'calendly_calendar_sync_duration_seconds',
  help: 'Duration of calendar sync in seconds',
  labelNames: ['provider'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

/**
 * Gauge for calendar sync lag.
 * Time since last successful sync per user.
 */
export const calendarSyncLag = new Gauge({
  name: 'calendly_calendar_sync_lag_seconds',
  help: 'Seconds since last successful calendar sync',
  labelNames: ['provider'] as const,
  registers: [register],
});

// ============================================================================
// CACHE METRICS
// ============================================================================

/**
 * Counter for cache operations.
 * Tracks hits and misses for monitoring cache effectiveness.
 */
export const cacheOperationsTotal = new Counter({
  name: 'calendly_cache_operations_total',
  help: 'Total number of cache operations',
  labelNames: ['operation', 'cache_type'] as const,
  registers: [register],
});

// ============================================================================
// DATABASE METRICS
// ============================================================================

/**
 * Histogram for database query duration.
 * Monitors query performance across different operations.
 */
export const dbQueryDuration = new Histogram({
  name: 'calendly_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

/**
 * Gauge for database connection pool status.
 */
export const dbPoolGauge = new Gauge({
  name: 'calendly_db_pool_connections',
  help: 'Database connection pool status',
  labelNames: ['state'] as const,
  registers: [register],
});

// ============================================================================
// EMAIL/NOTIFICATION METRICS
// ============================================================================

/**
 * Counter for email notification operations.
 */
export const emailNotificationsTotal = new Counter({
  name: 'calendly_email_notifications_total',
  help: 'Total number of email notifications',
  labelNames: ['type', 'status'] as const,
  registers: [register],
});

// ============================================================================
// HTTP REQUEST METRICS
// ============================================================================

/**
 * Histogram for HTTP request duration.
 * Standard RED metrics (Rate, Errors, Duration).
 */
export const httpRequestDuration = new Histogram({
  name: 'calendly_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Counter for HTTP requests total.
 */
export const httpRequestsTotal = new Counter({
  name: 'calendly_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

/**
 * Helper function to record booking operation metrics.
 */
export function recordBookingOperation(
  operation: 'create' | 'cancel' | 'reschedule',
  status: 'success' | 'failure' | 'conflict'
) {
  bookingOperationsTotal.labels(operation, status).inc();
}

/**
 * Helper function to record availability check metrics.
 */
export function recordAvailabilityCheck(cacheHit: boolean) {
  availabilityChecksTotal.labels(cacheHit ? 'true' : 'false').inc();
}

/**
 * Helper function to record cache operations.
 */
export function recordCacheOperation(
  operation: 'hit' | 'miss' | 'set' | 'delete',
  cacheType: 'availability' | 'meeting_type' | 'user' | 'slots'
) {
  cacheOperationsTotal.labels(operation, cacheType).inc();
}

export default register;
