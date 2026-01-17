import client from 'prom-client';
import config from '../config.js';

// Create a Registry for metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop)
client.collectDefaultMetrics({
  register,
  prefix: 'etsy_',
});

// HTTP request duration histogram
export const httpRequestDuration = new client.Histogram({
  name: 'etsy_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [register],
});

// HTTP request counter
export const httpRequestsTotal = new client.Counter({
  name: 'etsy_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Product metrics
export const productViews = new client.Counter({
  name: 'etsy_product_views_total',
  help: 'Total number of product page views',
  labelNames: ['category_id'],
  registers: [register],
});

export const productListings = new client.Gauge({
  name: 'etsy_product_listings_active',
  help: 'Number of active product listings',
  registers: [register],
});

// Search metrics
export const searchQueries = new client.Counter({
  name: 'etsy_search_queries_total',
  help: 'Total number of search queries',
  labelNames: ['has_filters'],
  registers: [register],
});

export const searchLatency = new client.Histogram({
  name: 'etsy_search_latency_seconds',
  help: 'Search query latency in seconds',
  labelNames: ['query_type'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1],
  registers: [register],
});

export const searchResultsCount = new client.Histogram({
  name: 'etsy_search_results_count',
  help: 'Number of results returned per search',
  labelNames: ['query_type'],
  buckets: [0, 1, 5, 10, 20, 50, 100],
  registers: [register],
});

// Order metrics
export const ordersCreated = new client.Counter({
  name: 'etsy_orders_created_total',
  help: 'Total number of orders created',
  labelNames: ['status'],
  registers: [register],
});

export const orderValue = new client.Histogram({
  name: 'etsy_order_value_dollars',
  help: 'Order value in dollars',
  buckets: [10, 25, 50, 100, 200, 500, 1000],
  registers: [register],
});

export const checkoutDuration = new client.Histogram({
  name: 'etsy_checkout_duration_seconds',
  help: 'Checkout processing time in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const ordersByShop = new client.Counter({
  name: 'etsy_orders_by_shop_total',
  help: 'Total orders per shop',
  labelNames: ['shop_id'],
  registers: [register],
});

// Cart metrics
export const cartOperations = new client.Counter({
  name: 'etsy_cart_operations_total',
  help: 'Total cart operations',
  labelNames: ['operation'], // add, update, remove
  registers: [register],
});

export const cartAbandonments = new client.Counter({
  name: 'etsy_cart_abandonments_total',
  help: 'Number of abandoned carts (items removed after 30min inactivity)',
  registers: [register],
});

// Cache metrics
export const cacheHits = new client.Counter({
  name: 'etsy_cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type'], // product, shop, search
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: 'etsy_cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type'],
  registers: [register],
});

export const cacheInvalidations = new client.Counter({
  name: 'etsy_cache_invalidations_total',
  help: 'Total cache invalidations',
  labelNames: ['cache_type', 'reason'],
  registers: [register],
});

// Circuit breaker metrics
export const circuitBreakerState = new client.Gauge({
  name: 'etsy_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['service'],
  registers: [register],
});

export const circuitBreakerFailures = new client.Counter({
  name: 'etsy_circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['service'],
  registers: [register],
});

// Database metrics
export const dbQueryDuration = new client.Histogram({
  name: 'etsy_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

export const dbConnectionsActive = new client.Gauge({
  name: 'etsy_db_connections_active',
  help: 'Number of active database connections',
  registers: [register],
});

// Idempotency metrics
export const idempotencyKeyHits = new client.Counter({
  name: 'etsy_idempotency_key_hits_total',
  help: 'Number of duplicate requests prevented by idempotency keys',
  registers: [register],
});

// Express middleware to track request metrics
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path;
    const method = req.method;
    const statusCode = res.statusCode.toString();

    httpRequestDuration.labels(method, route, statusCode).observe(duration);
    httpRequestsTotal.labels(method, route, statusCode).inc();
  });

  next();
}

// Get metrics for /metrics endpoint
export async function getMetrics() {
  return register.metrics();
}

// Get content type for /metrics endpoint
export function getMetricsContentType() {
  return register.contentType;
}

export default register;
