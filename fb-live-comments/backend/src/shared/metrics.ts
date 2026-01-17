/**
 * Prometheus Metrics Module
 *
 * Provides centralized metrics collection using prom-client.
 * Exposes metrics for WebSocket connections, comments, reactions,
 * database operations, and rate limiting for capacity planning and alerting.
 *
 * @module shared/metrics
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

/** Custom registry for application metrics */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ============================================================
// WebSocket Connection Metrics
// ============================================================

/**
 * Total number of active WebSocket connections.
 * Labeled by stream_id for per-stream monitoring.
 */
export const wsConnectionsGauge = new Gauge({
  name: 'ws_connections_total',
  help: 'Current number of WebSocket connections',
  labelNames: ['stream_id'],
  registers: [metricsRegistry],
});

/**
 * Total WebSocket connections opened since server start.
 */
export const wsConnectionsOpenedCounter = new Counter({
  name: 'ws_connections_opened_total',
  help: 'Total WebSocket connections opened',
  registers: [metricsRegistry],
});

/**
 * Total WebSocket connections closed since server start.
 */
export const wsConnectionsClosedCounter = new Counter({
  name: 'ws_connections_closed_total',
  help: 'Total WebSocket connections closed',
  labelNames: ['reason'],
  registers: [metricsRegistry],
});

/**
 * WebSocket message sizes for bandwidth monitoring.
 */
export const wsMessageSizeHistogram = new Histogram({
  name: 'ws_message_size_bytes',
  help: 'WebSocket message payload size in bytes',
  labelNames: ['direction', 'type'],
  buckets: [64, 256, 1024, 4096, 16384, 65536],
  registers: [metricsRegistry],
});

// ============================================================
// Comment Metrics
// ============================================================

/**
 * Total comments posted, labeled by stream and moderation status.
 */
export const commentsPostedCounter = new Counter({
  name: 'comments_posted_total',
  help: 'Total number of comments posted',
  labelNames: ['stream_id', 'status'],
  registers: [metricsRegistry],
});

/**
 * End-to-end comment delivery latency from post to broadcast.
 */
export const commentLatencyHistogram = new Histogram({
  name: 'comment_latency_ms',
  help: 'Comment delivery latency in milliseconds',
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [metricsRegistry],
});

// ============================================================
// Reaction Metrics
// ============================================================

/**
 * Total reactions posted, labeled by stream and reaction type.
 */
export const reactionsPostedCounter = new Counter({
  name: 'reactions_posted_total',
  help: 'Total number of reactions posted',
  labelNames: ['stream_id', 'type'],
  registers: [metricsRegistry],
});

// ============================================================
// Viewer Metrics
// ============================================================

/**
 * Peak concurrent viewers per stream.
 */
export const peakViewersGauge = new Gauge({
  name: 'peak_viewers',
  help: 'Peak number of concurrent viewers per stream',
  labelNames: ['stream_id'],
  registers: [metricsRegistry],
});

// ============================================================
// Database Metrics
// ============================================================

/**
 * Database query duration for performance monitoring.
 */
export const dbQueryDurationHistogram = new Histogram({
  name: 'db_query_duration_ms',
  help: 'Database query duration in milliseconds',
  labelNames: ['query_type', 'success'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [metricsRegistry],
});

/**
 * Database connection pool utilization.
 */
export const dbPoolGauge = new Gauge({
  name: 'db_pool_connections',
  help: 'Database connection pool status',
  labelNames: ['state'],
  registers: [metricsRegistry],
});

// ============================================================
// Circuit Breaker Metrics
// ============================================================

/**
 * Circuit breaker state changes.
 */
export const circuitBreakerStateGauge = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['name'],
  registers: [metricsRegistry],
});

/**
 * Circuit breaker failure count.
 */
export const circuitBreakerFailuresCounter = new Counter({
  name: 'circuit_breaker_failures_total',
  help: 'Total circuit breaker failures',
  labelNames: ['name'],
  registers: [metricsRegistry],
});

// ============================================================
// Rate Limiting Metrics
// ============================================================

/**
 * Rate limit violations for abuse detection and tuning.
 */
export const rateLimitExceededCounter = new Counter({
  name: 'rate_limit_exceeded_total',
  help: 'Total number of rate limit violations',
  labelNames: ['limit_type', 'user_id'],
  registers: [metricsRegistry],
});

// ============================================================
// Idempotency Metrics
// ============================================================

/**
 * Duplicate comment requests detected by idempotency key.
 */
export const idempotencyDuplicatesCounter = new Counter({
  name: 'idempotency_duplicates_total',
  help: 'Total duplicate requests detected by idempotency key',
  registers: [metricsRegistry],
});

/**
 * Returns Prometheus metrics in text format for /metrics endpoint.
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Returns metrics content type header.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}
