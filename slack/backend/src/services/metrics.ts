/**
 * @fileoverview Prometheus metrics service for monitoring and observability.
 * Exposes application metrics for message throughput, WebSocket connections,
 * HTTP request latencies, and cache hit rates.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Custom Prometheus registry for application metrics.
 * Using a custom registry allows for better control over default metrics.
 */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Counter for total messages sent across the application.
 * Labels: workspace_id, channel_type (public, private, dm)
 */
export const messagesSentCounter = new Counter({
  name: 'slack_messages_sent_total',
  help: 'Total number of messages sent',
  labelNames: ['workspace_id', 'channel_type'],
  registers: [metricsRegistry],
});

/**
 * Counter for total messages delivered via WebSocket.
 */
export const messagesDeliveredCounter = new Counter({
  name: 'slack_messages_delivered_total',
  help: 'Total number of messages delivered via WebSocket',
  registers: [metricsRegistry],
});

/**
 * Gauge for current number of active WebSocket connections.
 */
export const websocketConnectionsGauge = new Gauge({
  name: 'slack_websocket_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [metricsRegistry],
});

/**
 * Gauge for current number of unique users connected via WebSocket.
 */
export const websocketUsersGauge = new Gauge({
  name: 'slack_websocket_users_active',
  help: 'Number of unique users with active WebSocket connections',
  registers: [metricsRegistry],
});

/**
 * Histogram for HTTP request duration in seconds.
 * Labels: method, route, status_code
 */
export const httpRequestDurationHistogram = new Histogram({
  name: 'slack_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Counter for total HTTP requests.
 * Labels: method, route, status_code
 */
export const httpRequestsCounter = new Counter({
  name: 'slack_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

/**
 * Counter for cache hits and misses.
 * Labels: cache_name, result (hit/miss)
 */
export const cacheCounter = new Counter({
  name: 'slack_cache_operations_total',
  help: 'Total number of cache operations',
  labelNames: ['cache_name', 'result'],
  registers: [metricsRegistry],
});

/**
 * Counter for rate limit hits.
 * Labels: endpoint, user_id
 */
export const rateLimitCounter = new Counter({
  name: 'slack_rate_limit_hits_total',
  help: 'Total number of rate limit rejections',
  labelNames: ['endpoint'],
  registers: [metricsRegistry],
});

/**
 * Counter for idempotency cache hits (duplicate request detection).
 */
export const idempotencyHitsCounter = new Counter({
  name: 'slack_idempotency_hits_total',
  help: 'Total number of duplicate requests detected via idempotency',
  registers: [metricsRegistry],
});

/**
 * Histogram for database query duration.
 * Labels: query_type (select, insert, update, delete)
 */
export const dbQueryDurationHistogram = new Histogram({
  name: 'slack_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['query_type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Returns the current metrics in Prometheus text format.
 * @returns Promise resolving to metrics string
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Returns the content type for Prometheus metrics response.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}
