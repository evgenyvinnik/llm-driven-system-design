/**
 * Prometheus metrics collection for monitoring and observability.
 * Provides request metrics, business metrics, and infrastructure metrics.
 * Metrics are exposed via /metrics endpoint in Prometheus format.
 */
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

/** Global metrics registry */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/** Total HTTP requests by method, endpoint, and status code */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'endpoint', 'status'],
  registers: [metricsRegistry],
});

/** HTTP request duration in seconds */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'endpoint'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

// ============================================================================
// Business Metrics - Ticket Sales
// ============================================================================

/** Total seats reserved by event */
export const seatsReservedTotal = new Counter({
  name: 'seats_reserved_total',
  help: 'Total number of seats reserved',
  labelNames: ['event_id'],
  registers: [metricsRegistry],
});

/** Total seats sold by event */
export const seatsSoldTotal = new Counter({
  name: 'seats_sold_total',
  help: 'Total number of seats sold',
  labelNames: ['event_id'],
  registers: [metricsRegistry],
});

/** Total checkout completions by event */
export const checkoutCompletedTotal = new Counter({
  name: 'checkout_completed_total',
  help: 'Total number of completed checkouts',
  labelNames: ['event_id'],
  registers: [metricsRegistry],
});

/** Total checkout failures by event and reason */
export const checkoutFailedTotal = new Counter({
  name: 'checkout_failed_total',
  help: 'Total number of failed checkouts',
  labelNames: ['event_id', 'reason'],
  registers: [metricsRegistry],
});

/** Checkout processing duration in seconds */
export const checkoutDuration = new Histogram({
  name: 'checkout_duration_seconds',
  help: 'Time taken to complete checkout',
  labelNames: ['event_id'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [metricsRegistry],
});

// ============================================================================
// Queue Metrics - Virtual Waiting Room
// ============================================================================

/** Current queue length by event */
export const queueLength = new Gauge({
  name: 'queue_length',
  help: 'Current waiting queue length',
  labelNames: ['event_id'],
  registers: [metricsRegistry],
});

/** Current active sessions by event */
export const activeSessions = new Gauge({
  name: 'active_sessions',
  help: 'Current active shopping sessions',
  labelNames: ['event_id'],
  registers: [metricsRegistry],
});

/** Queue wait time distribution in seconds */
export const queueWaitTime = new Histogram({
  name: 'queue_wait_time_seconds',
  help: 'Time spent waiting in queue',
  labelNames: ['event_id'],
  buckets: [5, 10, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

// ============================================================================
// Inventory Metrics
// ============================================================================

/** Current available seats by event */
export const availableSeats = new Gauge({
  name: 'available_seats',
  help: 'Current number of available seats',
  labelNames: ['event_id'],
  registers: [metricsRegistry],
});

/** Seat lock acquisition success/failure */
export const seatLockAttempts = new Counter({
  name: 'seat_lock_attempts_total',
  help: 'Total seat lock acquisition attempts',
  labelNames: ['event_id', 'result'],
  registers: [metricsRegistry],
});

// ============================================================================
// Infrastructure Metrics
// ============================================================================

/** Redis operation duration */
export const redisOperationDuration = new Histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Redis operation duration in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers: [metricsRegistry],
});

/** PostgreSQL query duration */
export const postgresQueryDuration = new Histogram({
  name: 'postgres_query_duration_seconds',
  help: 'PostgreSQL query duration in seconds',
  labelNames: ['query_type'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/** Connection pool size */
export const connectionPoolSize = new Gauge({
  name: 'connection_pool_size',
  help: 'Current connection pool size',
  labelNames: ['type'],
  registers: [metricsRegistry],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/** Circuit breaker state (0=closed, 1=open, 2=half-open) */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [metricsRegistry],
});

/** Circuit breaker trip count */
export const circuitBreakerTrips = new Counter({
  name: 'circuit_breaker_trips_total',
  help: 'Total number of circuit breaker trips',
  labelNames: ['name'],
  registers: [metricsRegistry],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/** Idempotency cache hits */
export const idempotencyHits = new Counter({
  name: 'idempotency_hits_total',
  help: 'Total number of idempotency cache hits',
  registers: [metricsRegistry],
});

/** Idempotency cache misses */
export const idempotencyMisses = new Counter({
  name: 'idempotency_misses_total',
  help: 'Total number of idempotency cache misses',
  registers: [metricsRegistry],
});

/**
 * Express middleware for collecting HTTP metrics.
 * Should be applied early in the middleware chain.
 */
export function metricsMiddleware() {
  return (req: { method: string; path: string }, res: { statusCode: number; on: (event: string, callback: () => void) => void }, next: () => void) => {
    const start = process.hrtime.bigint();
    const endpoint = normalizeEndpoint(req.path);

    res.on('finish', () => {
      const duration = Number(process.hrtime.bigint() - start) / 1e9;
      const status = res.statusCode.toString();

      httpRequestsTotal.inc({ method: req.method, endpoint, status });
      httpRequestDuration.observe({ method: req.method, endpoint }, duration);
    });

    next();
  };
}

/**
 * Normalizes endpoint paths for consistent metric labels.
 * Replaces dynamic segments (UUIDs, numbers) with placeholders.
 */
function normalizeEndpoint(path: string): string {
  return path
    // Replace UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    // Replace numeric IDs
    .replace(/\/\d+/g, '/:id')
    // Limit depth
    .split('/')
    .slice(0, 5)
    .join('/');
}
