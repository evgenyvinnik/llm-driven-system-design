/**
 * @fileoverview Prometheus metrics for observability.
 * Provides application-level metrics for monitoring request latency,
 * error rates, queue depths, and business metrics.
 */

import client from 'prom-client';
import { config } from '../config/index.js';

// Create a Registry to register the metrics
const register = new client.Registry();

// Add default labels
register.setDefaultLabels({
  app: 'app-store',
  env: config.nodeEnv,
});

// Enable default Node.js metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

// =============================================================================
// HTTP Request Metrics
// =============================================================================

/**
 * HTTP request duration histogram.
 * Tracks latency distribution for all HTTP endpoints.
 */
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * HTTP request counter.
 * Total count of HTTP requests by method, route, and status.
 */
export const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

/**
 * Active HTTP connections gauge.
 * Number of currently active HTTP connections.
 */
export const httpActiveConnections = new client.Gauge({
  name: 'http_active_connections',
  help: 'Number of active HTTP connections',
  registers: [register],
});

// =============================================================================
// Database Metrics
// =============================================================================

/**
 * Database query duration histogram.
 */
export const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

/**
 * Database connection pool size gauge.
 */
export const dbPoolSize = new client.Gauge({
  name: 'db_pool_size',
  help: 'Number of connections in the database pool',
  labelNames: ['state'], // 'active', 'idle', 'waiting'
  registers: [register],
});

// =============================================================================
// Cache Metrics
// =============================================================================

/**
 * Cache hit/miss counter.
 */
export const cacheOperations = new client.Counter({
  name: 'cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['operation', 'result'], // operation: get/set/delete, result: hit/miss
  registers: [register],
});

/**
 * Cache operation duration histogram.
 */
export const cacheDuration = new client.Histogram({
  name: 'cache_operation_duration_seconds',
  help: 'Duration of cache operations in seconds',
  labelNames: ['operation'],
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05],
  registers: [register],
});

// =============================================================================
// Message Queue Metrics
// =============================================================================

/**
 * Messages published counter.
 */
export const mqMessagesPublished = new client.Counter({
  name: 'mq_messages_published_total',
  help: 'Total messages published to queues',
  labelNames: ['queue', 'event_type', 'status'], // status: success/failure
  registers: [register],
});

/**
 * Messages consumed counter.
 */
export const mqMessagesConsumed = new client.Counter({
  name: 'mq_messages_consumed_total',
  help: 'Total messages consumed from queues',
  labelNames: ['queue', 'event_type', 'status'], // status: success/failure/requeued
  registers: [register],
});

/**
 * Message processing duration histogram.
 */
export const mqProcessingDuration = new client.Histogram({
  name: 'mq_message_processing_duration_seconds',
  help: 'Duration of message processing in seconds',
  labelNames: ['queue', 'event_type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
  registers: [register],
});

/**
 * Queue depth gauge (approximate).
 */
export const mqQueueDepth = new client.Gauge({
  name: 'mq_queue_depth',
  help: 'Approximate number of messages in queue',
  labelNames: ['queue'],
  registers: [register],
});

// =============================================================================
// Circuit Breaker Metrics
// =============================================================================

/**
 * Circuit breaker state gauge.
 * 0 = closed, 1 = half-open, 2 = open
 */
export const circuitBreakerState = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['name'],
  registers: [register],
});

/**
 * Circuit breaker failure counter.
 */
export const circuitBreakerFailures = new client.Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['name'],
  registers: [register],
});

/**
 * Circuit breaker success counter.
 */
export const circuitBreakerSuccesses = new client.Counter({
  name: 'circuit_breaker_successes_total',
  help: 'Total circuit breaker successes',
  labelNames: ['name'],
  registers: [register],
});

// =============================================================================
// Business Metrics
// =============================================================================

/**
 * App downloads counter.
 */
export const downloadsTotal = new client.Counter({
  name: 'app_downloads_total',
  help: 'Total app downloads',
  labelNames: ['app_id', 'is_free'],
  registers: [register],
});

/**
 * Reviews submitted counter.
 */
export const reviewsSubmitted = new client.Counter({
  name: 'reviews_submitted_total',
  help: 'Total reviews submitted',
  labelNames: ['status'], // published, pending (held for moderation)
  registers: [register],
});

/**
 * Purchases counter.
 */
export const purchasesTotal = new client.Counter({
  name: 'purchases_total',
  help: 'Total purchases',
  labelNames: ['status'], // success, failed, duplicate
  registers: [register],
});

/**
 * Revenue gauge (for monitoring purposes only - not authoritative).
 */
export const revenueTotal = new client.Counter({
  name: 'revenue_total',
  help: 'Total revenue in cents',
  labelNames: ['currency'],
  registers: [register],
});

/**
 * Idempotency cache hits counter.
 * Tracks duplicate request detection.
 */
export const idempotencyHits = new client.Counter({
  name: 'idempotency_hits_total',
  help: 'Total idempotent request cache hits (duplicate requests)',
  labelNames: ['operation'],
  registers: [register],
});

// =============================================================================
// Health Check Metrics
// =============================================================================

/**
 * Service health gauge.
 * 1 = healthy, 0 = unhealthy
 */
export const serviceHealth = new client.Gauge({
  name: 'service_health',
  help: 'Service health status (1=healthy, 0=unhealthy)',
  labelNames: ['dependency'], // postgres, redis, elasticsearch, rabbitmq, minio
  registers: [register],
});

// =============================================================================
// Exports
// =============================================================================

export { register };

/**
 * Express middleware for collecting HTTP metrics.
 * Should be registered before route handlers.
 */
export function metricsMiddleware() {
  return (req: any, res: any, next: any) => {
    const startTime = process.hrtime.bigint();
    httpActiveConnections.inc();

    res.on('finish', () => {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1e9; // Convert to seconds

      const route = req.route?.path || req.path || 'unknown';
      const labels = {
        method: req.method,
        route,
        status_code: res.statusCode.toString(),
      };

      httpRequestDuration.observe(labels, duration);
      httpRequestTotal.inc(labels);
      httpActiveConnections.dec();
    });

    next();
  };
}

/**
 * Returns metrics in Prometheus format.
 * Use this to expose a /metrics endpoint.
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Returns the content type for Prometheus metrics.
 */
export function getMetricsContentType(): string {
  return register.contentType;
}
