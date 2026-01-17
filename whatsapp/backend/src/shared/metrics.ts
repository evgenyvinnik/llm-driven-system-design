/**
 * Prometheus metrics module for observability.
 *
 * Exposes key application metrics for monitoring message delivery performance,
 * system health, and operational visibility via the /metrics endpoint.
 *
 * WHY metrics enable delivery optimization:
 * - Real-time visibility into message delivery latency and success rates
 * - Identifies bottlenecks before they impact users (database, Redis, network)
 * - Enables capacity planning based on actual usage patterns
 * - Supports alerting on SLO violations (latency > 200ms, delivery rate < 99%)
 * - Provides data for A/B testing delivery optimizations
 *
 * Key metrics:
 * - messages_total: Counter by status (sent, delivered, read, failed)
 * - message_delivery_duration: Histogram of delivery latency
 * - websocket_connections: Gauge of active connections
 * - http_request_duration: Histogram of API response times
 */

import client from 'prom-client';
import { config } from '../config.js';

// Create a Registry to hold metrics
export const metricsRegistry = new client.Registry();

// Add default labels
metricsRegistry.setDefaultLabels({
  app: 'whatsapp-api',
  server_id: config.serverId,
});

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register: metricsRegistry });

/**
 * Counter for total messages processed, labeled by status.
 * Used to track message flow through the system and calculate delivery rates.
 */
export const messagesTotal = new client.Counter({
  name: 'whatsapp_messages_total',
  help: 'Total number of messages processed',
  labelNames: ['status', 'content_type'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for message delivery latency (time from send to delivery ACK).
 * Critical for monitoring SLO compliance (target: 95th percentile < 200ms).
 */
export const messageDeliveryDuration = new client.Histogram({
  name: 'whatsapp_message_delivery_duration_seconds',
  help: 'Time from message send to delivery confirmation',
  labelNames: ['delivery_type'] as const, // 'local', 'cross_server', 'pending'
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Gauge for current WebSocket connections.
 * Used for load balancing decisions and capacity monitoring.
 */
export const websocketConnections = new client.Gauge({
  name: 'whatsapp_websocket_connections_total',
  help: 'Current number of active WebSocket connections',
  registers: [metricsRegistry],
});

/**
 * Counter for WebSocket connection events.
 * Tracks connection lifecycle for debugging and monitoring.
 */
export const websocketEvents = new client.Counter({
  name: 'whatsapp_websocket_events_total',
  help: 'WebSocket connection events',
  labelNames: ['event'] as const, // 'connect', 'disconnect', 'error'
  registers: [metricsRegistry],
});

/**
 * Histogram for HTTP request duration.
 * Monitors API latency for REST endpoints.
 */
export const httpRequestDuration = new client.Histogram({
  name: 'whatsapp_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/**
 * Counter for rate limit hits.
 * Tracks when users are being throttled for spam prevention.
 */
export const rateLimitHits = new client.Counter({
  name: 'whatsapp_rate_limit_hits_total',
  help: 'Number of requests rejected by rate limiting',
  labelNames: ['endpoint'] as const,
  registers: [metricsRegistry],
});

/**
 * Gauge for circuit breaker state.
 * 0 = closed (healthy), 1 = open (failing), 0.5 = half-open (testing)
 */
export const circuitBreakerState = new client.Gauge({
  name: 'whatsapp_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 0.5=half-open, 1=open)',
  labelNames: ['name'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for retry attempts.
 * Tracks how often delivery retries are needed.
 */
export const retryAttempts = new client.Counter({
  name: 'whatsapp_retry_attempts_total',
  help: 'Number of retry attempts for operations',
  labelNames: ['operation', 'success'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter for database operations.
 * Monitors database query patterns and errors.
 */
export const dbOperations = new client.Counter({
  name: 'whatsapp_db_operations_total',
  help: 'Database operations count',
  labelNames: ['operation', 'success'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram for database query duration.
 */
export const dbQueryDuration = new client.Histogram({
  name: 'whatsapp_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Helper function to record message metrics.
 *
 * @param status - Message status (sent, delivered, read, failed)
 * @param contentType - Type of content (text, image, video, file)
 */
export function recordMessage(
  status: 'sent' | 'delivered' | 'read' | 'failed',
  contentType: string = 'text'
) {
  messagesTotal.inc({ status, content_type: contentType });
}

/**
 * Helper function to record message delivery timing.
 *
 * @param durationSeconds - Time taken for delivery in seconds
 * @param deliveryType - Type of delivery (local, cross_server, pending)
 */
export function recordDeliveryDuration(
  durationSeconds: number,
  deliveryType: 'local' | 'cross_server' | 'pending'
) {
  messageDeliveryDuration.observe({ delivery_type: deliveryType }, durationSeconds);
}

/**
 * Express middleware for collecting HTTP metrics.
 */
export function metricsMiddleware(req: any, res: any, next: any) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSeconds = durationNs / 1e9;

    // Normalize route for metrics (avoid high cardinality from IDs)
    let route = req.route?.path || req.path;
    route = route
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+/g, '/:id');

    httpRequestDuration.observe(
      {
        method: req.method,
        route,
        status_code: res.statusCode,
      },
      durationSeconds
    );
  });

  next();
}

/**
 * Returns metrics in Prometheus text format.
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}
