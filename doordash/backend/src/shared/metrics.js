import promClient from 'prom-client';

// Create a Registry to register metrics
const register = new promClient.Registry();

// Add default metrics (CPU, memory, event loop, etc.)
promClient.collectDefaultMetrics({ register });

// ============================================
// HTTP Request Metrics
// ============================================

export const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// ============================================
// Order Metrics
// ============================================

export const ordersTotal = new promClient.Counter({
  name: 'orders_total',
  help: 'Total orders by status',
  labelNames: ['status', 'restaurant_id'],
  registers: [register],
});

export const ordersActive = new promClient.Gauge({
  name: 'orders_active',
  help: 'Currently active orders by status',
  labelNames: ['status'],
  registers: [register],
});

export const orderStatusTransitions = new promClient.Counter({
  name: 'order_status_transitions_total',
  help: 'Order status transitions',
  labelNames: ['from_status', 'to_status'],
  registers: [register],
});

export const orderPlacementDuration = new promClient.Histogram({
  name: 'order_placement_duration_seconds',
  help: 'Time to place an order (from request to confirmation)',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// ============================================
// Delivery Time Metrics
// ============================================

export const deliveryDuration = new promClient.Histogram({
  name: 'delivery_duration_minutes',
  help: 'Actual delivery time from order placement to delivery',
  buckets: [10, 15, 20, 25, 30, 40, 50, 60, 90],
  registers: [register],
});

export const etaAccuracy = new promClient.Histogram({
  name: 'eta_accuracy_minutes',
  help: 'Difference between estimated and actual delivery time (positive = late, negative = early)',
  buckets: [-15, -10, -5, -2, 0, 2, 5, 10, 15, 30],
  registers: [register],
});

// ============================================
// Driver Metrics
// ============================================

export const driversActive = new promClient.Gauge({
  name: 'drivers_active',
  help: 'Number of active drivers',
  registers: [register],
});

export const driversAvailable = new promClient.Gauge({
  name: 'drivers_available',
  help: 'Number of available drivers',
  registers: [register],
});

export const driverMatchDuration = new promClient.Histogram({
  name: 'driver_match_duration_seconds',
  help: 'Time to match a driver to an order',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const driverAssignmentsTotal = new promClient.Counter({
  name: 'driver_assignments_total',
  help: 'Total driver assignments',
  labelNames: ['result'], // 'success', 'no_drivers', 'timeout'
  registers: [register],
});

export const driverLocationUpdates = new promClient.Counter({
  name: 'driver_location_updates_total',
  help: 'Total driver location updates',
  registers: [register],
});

// ============================================
// Cache Metrics
// ============================================

export const cacheHits = new promClient.Counter({
  name: 'cache_hits_total',
  help: 'Cache hits by key type',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheMisses = new promClient.Counter({
  name: 'cache_misses_total',
  help: 'Cache misses by key type',
  labelNames: ['cache_type'],
  registers: [register],
});

// ============================================
// Circuit Breaker Metrics
// ============================================

export const circuitBreakerState = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerFailures = new promClient.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Circuit breaker failures',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerSuccesses = new promClient.Counter({
  name: 'circuit_breaker_successes_total',
  help: 'Circuit breaker successes',
  labelNames: ['service'],
  registers: [register],
});

// ============================================
// Idempotency Metrics
// ============================================

export const idempotencyHits = new promClient.Counter({
  name: 'idempotency_hits_total',
  help: 'Requests served from idempotency cache',
  labelNames: ['operation'],
  registers: [register],
});

/**
 * Express middleware for collecting HTTP metrics
 */
export function metricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode,
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Get metrics in Prometheus format
 */
export async function getMetrics() {
  return register.metrics();
}

/**
 * Get content type for metrics
 */
export function getContentType() {
  return register.contentType;
}

export { register };
