/**
 * Prometheus metrics for observability and monitoring.
 * Provides counters, gauges, and histograms for key business and operational metrics.
 *
 * Features:
 * - Order lifecycle metrics (created, completed, cancelled)
 * - Driver assignment and delivery metrics
 * - HTTP request latency histograms
 * - Circuit breaker state metrics
 *
 * @module shared/metrics
 */
import client from 'prom-client';

// Enable default metrics (memory, CPU, etc.)
client.collectDefaultMetrics({
  prefix: 'delivery_',
});

/**
 * Registry for all application metrics.
 */
export const registry = client.register;

// ============================================================
// ORDER METRICS
// ============================================================

/**
 * Total number of orders created.
 */
export const ordersCreatedCounter = new client.Counter({
  name: 'delivery_orders_created_total',
  help: 'Total number of orders created',
  labelNames: ['merchant_category'],
});

/**
 * Total number of orders by final status.
 */
export const ordersCompletedCounter = new client.Counter({
  name: 'delivery_orders_completed_total',
  help: 'Total number of orders completed by final status',
  labelNames: ['status'],
});

/**
 * Order processing duration from creation to delivery.
 */
export const orderDurationHistogram = new client.Histogram({
  name: 'delivery_order_duration_seconds',
  help: 'Order processing duration from creation to delivery',
  labelNames: ['status'],
  buckets: [60, 300, 600, 900, 1200, 1800, 2700, 3600],
});

/**
 * Currently active orders by status.
 */
export const activeOrdersGauge = new client.Gauge({
  name: 'delivery_active_orders',
  help: 'Number of currently active orders',
  labelNames: ['status'],
});

// ============================================================
// DELIVERY METRICS
// ============================================================

/**
 * Total number of deliveries completed.
 */
export const deliveriesCompletedCounter = new client.Counter({
  name: 'delivery_deliveries_completed_total',
  help: 'Total number of deliveries completed',
  labelNames: ['vehicle_type'],
});

/**
 * Delivery distance histogram.
 */
export const deliveryDistanceHistogram = new client.Histogram({
  name: 'delivery_distance_km',
  help: 'Delivery distance in kilometers',
  buckets: [0.5, 1, 2, 3, 5, 7, 10, 15, 20],
});

/**
 * Delivery time histogram (from pickup to delivery).
 */
export const deliveryTimeHistogram = new client.Histogram({
  name: 'delivery_time_seconds',
  help: 'Delivery time from pickup to delivery in seconds',
  buckets: [120, 300, 600, 900, 1200, 1800, 2700, 3600],
});

// ============================================================
// DRIVER ASSIGNMENT METRICS
// ============================================================

/**
 * Total number of driver assignments.
 */
export const driverAssignmentsCounter = new client.Counter({
  name: 'delivery_driver_assignments_total',
  help: 'Total number of driver assignments',
  labelNames: ['result'], // 'accepted', 'rejected', 'expired', 'no_driver'
});

/**
 * Driver matching duration histogram.
 */
export const driverMatchingDurationHistogram = new client.Histogram({
  name: 'delivery_driver_matching_duration_seconds',
  help: 'Time taken to match a driver to an order',
  buckets: [1, 5, 10, 30, 60, 120, 180],
});

/**
 * Number of offers made before assignment.
 */
export const offersPerAssignmentHistogram = new client.Histogram({
  name: 'delivery_offers_per_assignment',
  help: 'Number of driver offers made before successful assignment',
  buckets: [1, 2, 3, 4, 5, 10],
});

/**
 * Currently online drivers.
 */
export const onlineDriversGauge = new client.Gauge({
  name: 'delivery_online_drivers',
  help: 'Number of currently online drivers',
  labelNames: ['status', 'vehicle_type'],
});

/**
 * Driver acceptance rate histogram.
 */
export const driverAcceptanceRateHistogram = new client.Histogram({
  name: 'delivery_driver_acceptance_rate',
  help: 'Distribution of driver acceptance rates',
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
});

// ============================================================
// CIRCUIT BREAKER METRICS
// ============================================================

/**
 * Circuit breaker state.
 */
export const circuitBreakerState = new client.Gauge({
  name: 'delivery_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
  labelNames: ['name'],
});

/**
 * Circuit breaker events.
 */
export const circuitBreakerEvents = new client.Counter({
  name: 'delivery_circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['name', 'event'], // 'open', 'close', 'half-open', 'success', 'failure', 'fallback'
});

// ============================================================
// HTTP REQUEST METRICS
// ============================================================

/**
 * HTTP request duration histogram.
 */
export const httpRequestDurationHistogram = new client.Histogram({
  name: 'delivery_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/**
 * HTTP requests total.
 */
export const httpRequestsTotal = new client.Counter({
  name: 'delivery_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// ============================================================
// DATABASE METRICS
// ============================================================

/**
 * Database query duration histogram.
 */
export const dbQueryDurationHistogram = new client.Histogram({
  name: 'delivery_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1],
});

/**
 * Active database connections.
 */
export const dbConnectionsGauge = new client.Gauge({
  name: 'delivery_db_connections',
  help: 'Number of active database connections',
  labelNames: ['state'], // 'active', 'idle', 'waiting'
});

// ============================================================
// REDIS METRICS
// ============================================================

/**
 * Redis operation duration histogram.
 */
export const redisOperationDurationHistogram = new client.Histogram({
  name: 'delivery_redis_operation_duration_seconds',
  help: 'Redis operation duration in seconds',
  labelNames: ['operation'],
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
});

export default {
  registry,
  ordersCreatedCounter,
  ordersCompletedCounter,
  orderDurationHistogram,
  activeOrdersGauge,
  deliveriesCompletedCounter,
  deliveryDistanceHistogram,
  deliveryTimeHistogram,
  driverAssignmentsCounter,
  driverMatchingDurationHistogram,
  offersPerAssignmentHistogram,
  onlineDriversGauge,
  driverAcceptanceRateHistogram,
  circuitBreakerState,
  circuitBreakerEvents,
  httpRequestDurationHistogram,
  httpRequestsTotal,
  dbQueryDurationHistogram,
  dbConnectionsGauge,
  redisOperationDurationHistogram,
};
