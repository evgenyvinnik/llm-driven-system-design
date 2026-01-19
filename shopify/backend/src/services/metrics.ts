import client, { Counter, Histogram, Gauge, Registry } from 'prom-client';
import { Request, Response, NextFunction } from 'express';

// Create a registry for metrics
const register = new Registry();

// Add default metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register });

// ======= HTTP Request Metrics =======

// Request duration histogram
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Total HTTP requests counter
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// ======= Business Metrics =======

// Checkout metrics
export const checkoutsTotal = new Counter({
  name: 'shopify_checkouts_total',
  help: 'Total checkout attempts',
  labelNames: ['store_id', 'status'] as const, // status: success, failed, abandoned
  registers: [register],
});

// Checkout latency
export const checkoutLatency = new Histogram({
  name: 'shopify_checkout_duration_seconds',
  help: 'Checkout processing duration in seconds',
  labelNames: ['store_id', 'status'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// Order value histogram
export const orderValue = new Histogram({
  name: 'shopify_order_value_dollars',
  help: 'Order value distribution in dollars',
  labelNames: ['store_id'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

// Orders created counter
export const ordersCreated = new Counter({
  name: 'shopify_orders_created_total',
  help: 'Total orders created',
  labelNames: ['store_id'] as const,
  registers: [register],
});

// Inventory level gauge
export const inventoryLevel = new Gauge({
  name: 'shopify_inventory_level',
  help: 'Current inventory level per variant',
  labelNames: ['store_id', 'variant_id', 'sku'] as const,
  registers: [register],
});

// Low inventory threshold alerts
export const inventoryLow = new Counter({
  name: 'shopify_inventory_low_total',
  help: 'Count of low inventory events',
  labelNames: ['store_id', 'variant_id'] as const,
  registers: [register],
});

// Out of stock events
export const inventoryOutOfStock = new Counter({
  name: 'shopify_inventory_out_of_stock_total',
  help: 'Count of out of stock events',
  labelNames: ['store_id', 'variant_id'] as const,
  registers: [register],
});

// ======= Queue Metrics =======

// Queue depth gauge
export const queueDepth = new Gauge({
  name: 'shopify_queue_depth',
  help: 'RabbitMQ queue message count',
  labelNames: ['queue_name'] as const,
  registers: [register],
});

// Queue processing time
export const queueProcessingTime = new Histogram({
  name: 'shopify_queue_processing_seconds',
  help: 'Queue message processing time in seconds',
  labelNames: ['queue_name'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
  registers: [register],
});

// Queue messages processed
export const queueMessagesProcessed = new Counter({
  name: 'shopify_queue_messages_processed_total',
  help: 'Total messages processed from queue',
  labelNames: ['queue_name', 'status'] as const, // status: success, failed, retried
  registers: [register],
});

// ======= Idempotency Metrics =======

export const idempotencyHits = new Counter({
  name: 'shopify_idempotency_hits_total',
  help: 'Number of requests that hit idempotency cache (duplicate requests)',
  labelNames: ['operation'] as const,
  registers: [register],
});

export const idempotencyMisses = new Counter({
  name: 'shopify_idempotency_misses_total',
  help: 'Number of requests that missed idempotency cache (new requests)',
  labelNames: ['operation'] as const,
  registers: [register],
});

// ======= Circuit Breaker Metrics =======

export const circuitBreakerState = new Gauge({
  name: 'shopify_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'] as const,
  registers: [register],
});

export const circuitBreakerFailures = new Counter({
  name: 'shopify_circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service'] as const,
  registers: [register],
});

export const circuitBreakerSuccesses = new Counter({
  name: 'shopify_circuit_breaker_successes_total',
  help: 'Total circuit breaker successes',
  labelNames: ['service'] as const,
  registers: [register],
});

// ======= Database Metrics =======

export const dbQueryDuration = new Histogram({
  name: 'shopify_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const dbConnectionsActive = new Gauge({
  name: 'shopify_db_connections_active',
  help: 'Number of active database connections',
  registers: [register],
});

// ======= Express Middleware =======

/**
 * Express middleware for collecting HTTP metrics
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path;
    const labels = {
      method: req.method,
      route: route,
      status_code: res.statusCode,
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Get metrics for /metrics endpoint
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get content type for metrics
 */
export function getContentType(): string {
  return register.contentType;
}

export { register };
export default {
  register,
  getMetrics,
  getContentType,
  metricsMiddleware,
  // HTTP
  httpRequestDuration,
  httpRequestsTotal,
  // Business
  checkoutsTotal,
  checkoutLatency,
  orderValue,
  ordersCreated,
  inventoryLevel,
  inventoryLow,
  inventoryOutOfStock,
  // Queue
  queueDepth,
  queueProcessingTime,
  queueMessagesProcessed,
  // Idempotency
  idempotencyHits,
  idempotencyMisses,
  // Circuit breaker
  circuitBreakerState,
  circuitBreakerFailures,
  circuitBreakerSuccesses,
  // Database
  dbQueryDuration,
  dbConnectionsActive,
};
