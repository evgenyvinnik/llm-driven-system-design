/**
 * Prometheus Metrics Collection
 *
 * Exposes key application metrics for monitoring:
 * - HTTP request latency and throughput
 * - Order operations (placement, cancellation, value distribution)
 * - Cart operations (add, remove, abandonment)
 * - Search performance
 * - Inventory operations (reservations, stock levels)
 * - Circuit breaker states
 */
import promClient, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { Request, Response, NextFunction, Router } from 'express';

interface ExtendedRoute {
  path?: string;
}

interface ExtendedRequest extends Omit<Request, 'route'> {
  route?: ExtendedRoute;
}

// Create a Registry to register metrics
const register = new Registry();

// Add default labels
register.setDefaultLabels({
  app: 'amazon-api',
  env: process.env.NODE_ENV || 'development'
});

// Enable default metrics (CPU, memory, event loop, etc.)
promClient.collectDefaultMetrics({ register });

// ============================================================
// HTTP Request Metrics
// ============================================================
export const httpRequestDuration: Histogram<string> = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

export const httpRequestsTotal: Counter<string> = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// ============================================================
// Order Metrics
// ============================================================
export const ordersTotal: Counter<string> = new promClient.Counter({
  name: 'orders_total',
  help: 'Total number of orders placed',
  labelNames: ['status', 'payment_method'],
  registers: [register]
});

export const orderValue: Histogram<string> = new promClient.Histogram({
  name: 'order_value_dollars',
  help: 'Distribution of order values in dollars',
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [register]
});

export const orderProcessingDuration: Histogram<string> = new promClient.Histogram({
  name: 'order_processing_duration_seconds',
  help: 'Time to process an order (checkout flow)',
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

export const orderCancellationsTotal: Counter<string> = new promClient.Counter({
  name: 'order_cancellations_total',
  help: 'Total number of order cancellations',
  labelNames: ['reason'],
  registers: [register]
});

export const idempotencyHitsTotal: Counter<string> = new promClient.Counter({
  name: 'idempotency_hits_total',
  help: 'Number of times an idempotency key was matched (duplicate request prevented)',
  registers: [register]
});

// ============================================================
// Cart Metrics
// ============================================================
export const cartOperationsTotal: Counter<string> = new promClient.Counter({
  name: 'cart_operations_total',
  help: 'Total cart operations',
  labelNames: ['operation'], // add, remove, update, clear
  registers: [register]
});

export const cartAbandonmentsTotal: Counter<string> = new promClient.Counter({
  name: 'cart_abandonments_total',
  help: 'Number of carts expired due to reservation timeout',
  registers: [register]
});

export const cartItemsGauge: Gauge<string> = new promClient.Gauge({
  name: 'cart_items_current',
  help: 'Current number of items across all active carts',
  registers: [register]
});

// ============================================================
// Inventory Metrics
// ============================================================
export const inventoryReservationsTotal: Counter<string> = new promClient.Counter({
  name: 'inventory_reservations_total',
  help: 'Total inventory reservation attempts',
  labelNames: ['status'], // success, insufficient, error
  registers: [register]
});

export const inventoryReleasesTotal: Counter<string> = new promClient.Counter({
  name: 'inventory_releases_total',
  help: 'Total inventory releases',
  labelNames: ['reason'], // checkout, expiry, manual
  registers: [register]
});

export const inventoryOversellsTotal: Counter<string> = new promClient.Counter({
  name: 'inventory_oversells_total',
  help: 'Number of times inventory oversell was prevented (should be zero!)',
  registers: [register]
});

// ============================================================
// Search Metrics
// ============================================================
export const searchLatency: Histogram<string> = new promClient.Histogram({
  name: 'search_latency_seconds',
  help: 'Search query latency',
  labelNames: ['query_type', 'engine'], // query_type: faceted, simple; engine: elasticsearch, postgresql
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register]
});

export const searchRequestsTotal: Counter<string> = new promClient.Counter({
  name: 'search_requests_total',
  help: 'Total search requests',
  labelNames: ['engine', 'has_results'],
  registers: [register]
});

export const searchFallbacksTotal: Counter<string> = new promClient.Counter({
  name: 'search_fallbacks_total',
  help: 'Number of times search fell back from Elasticsearch to PostgreSQL',
  registers: [register]
});

// ============================================================
// Circuit Breaker Metrics
// ============================================================
export const circuitBreakerState: Gauge<string> = new promClient.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'],
  registers: [register]
});

export const circuitBreakerTripsTotal: Counter<string> = new promClient.Counter({
  name: 'circuit_breaker_trips_total',
  help: 'Number of times circuit breaker tripped to open',
  labelNames: ['service'],
  registers: [register]
});

// ============================================================
// Database Metrics
// ============================================================
export const dbQueryDuration: Histogram<string> = new promClient.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['operation'], // select, insert, update, delete
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register]
});

export const dbConnectionPoolSize: Gauge<string> = new promClient.Gauge({
  name: 'db_connection_pool_size',
  help: 'Current database connection pool size',
  labelNames: ['state'], // total, idle, waiting
  registers: [register]
});

// ============================================================
// Audit Metrics
// ============================================================
export const auditEventsTotal: Counter<string> = new promClient.Counter({
  name: 'audit_events_total',
  help: 'Total audit events logged',
  labelNames: ['action', 'resource_type'],
  registers: [register]
});

// ============================================================
// Express Middleware for HTTP Metrics
// ============================================================
export function metricsMiddleware(
  req: ExtendedRequest,
  res: Response,
  next: NextFunction
): void {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9; // Convert to seconds

    // Normalize route for cardinality (avoid unique IDs in labels)
    const route = normalizeRoute(req.route?.path || req.path);

    httpRequestDuration.observe(
      { method: req.method, route, status_code: String(res.statusCode) },
      duration
    );

    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_code: String(res.statusCode)
    });
  });

  next();
}

/**
 * Normalize route to prevent high cardinality in metrics
 * e.g., /api/products/123 -> /api/products/:id
 */
function normalizeRoute(path: string): string {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[a-f0-9-]{36}/g, '/:uuid');
}

// ============================================================
// Metrics Endpoint Handler
// ============================================================
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    const err = error as Error;
    res.status(500).end(err.message);
  }
}

// Export registry for custom metrics registration
export { register };

export default {
  register,
  metricsHandler,
  metricsMiddleware
};
