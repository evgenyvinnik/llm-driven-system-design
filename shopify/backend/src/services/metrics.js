import client from 'prom-client';

// Create a registry for metrics
const register = new client.Registry();

// Add default metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register });

// ======= HTTP Request Metrics =======

// Request duration histogram
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Total HTTP requests counter
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// ======= Business Metrics =======

// Checkout metrics
export const checkoutsTotal = new client.Counter({
  name: 'shopify_checkouts_total',
  help: 'Total checkout attempts',
  labelNames: ['store_id', 'status'], // status: success, failed, abandoned
  registers: [register],
});

// Checkout latency
export const checkoutLatency = new client.Histogram({
  name: 'shopify_checkout_duration_seconds',
  help: 'Checkout processing duration in seconds',
  labelNames: ['store_id', 'status'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

// Order value histogram
export const orderValue = new client.Histogram({
  name: 'shopify_order_value_dollars',
  help: 'Order value distribution in dollars',
  labelNames: ['store_id'],
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register],
});

// Orders created counter
export const ordersCreated = new client.Counter({
  name: 'shopify_orders_created_total',
  help: 'Total orders created',
  labelNames: ['store_id'],
  registers: [register],
});

// Inventory level gauge
export const inventoryLevel = new client.Gauge({
  name: 'shopify_inventory_level',
  help: 'Current inventory level per variant',
  labelNames: ['store_id', 'variant_id', 'sku'],
  registers: [register],
});

// Low inventory threshold alerts
export const inventoryLow = new client.Counter({
  name: 'shopify_inventory_low_total',
  help: 'Count of low inventory events',
  labelNames: ['store_id', 'variant_id'],
  registers: [register],
});

// Out of stock events
export const inventoryOutOfStock = new client.Counter({
  name: 'shopify_inventory_out_of_stock_total',
  help: 'Count of out of stock events',
  labelNames: ['store_id', 'variant_id'],
  registers: [register],
});

// ======= Queue Metrics =======

// Queue depth gauge
export const queueDepth = new client.Gauge({
  name: 'shopify_queue_depth',
  help: 'RabbitMQ queue message count',
  labelNames: ['queue_name'],
  registers: [register],
});

// Queue processing time
export const queueProcessingTime = new client.Histogram({
  name: 'shopify_queue_processing_seconds',
  help: 'Queue message processing time in seconds',
  labelNames: ['queue_name'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
  registers: [register],
});

// Queue messages processed
export const queueMessagesProcessed = new client.Counter({
  name: 'shopify_queue_messages_processed_total',
  help: 'Total messages processed from queue',
  labelNames: ['queue_name', 'status'], // status: success, failed, retried
  registers: [register],
});

// ======= Idempotency Metrics =======

export const idempotencyHits = new client.Counter({
  name: 'shopify_idempotency_hits_total',
  help: 'Number of requests that hit idempotency cache (duplicate requests)',
  labelNames: ['operation'],
  registers: [register],
});

export const idempotencyMisses = new client.Counter({
  name: 'shopify_idempotency_misses_total',
  help: 'Number of requests that missed idempotency cache (new requests)',
  labelNames: ['operation'],
  registers: [register],
});

// ======= Circuit Breaker Metrics =======

export const circuitBreakerState = new client.Gauge({
  name: 'shopify_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerFailures = new client.Counter({
  name: 'shopify_circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerSuccesses = new client.Counter({
  name: 'shopify_circuit_breaker_successes_total',
  help: 'Total circuit breaker successes',
  labelNames: ['service'],
  registers: [register],
});

// ======= Database Metrics =======

export const dbQueryDuration = new client.Histogram({
  name: 'shopify_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const dbConnectionsActive = new client.Gauge({
  name: 'shopify_db_connections_active',
  help: 'Number of active database connections',
  registers: [register],
});

// ======= Express Middleware =======

/**
 * Express middleware for collecting HTTP metrics
 */
export function metricsMiddleware(req, res, next) {
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
