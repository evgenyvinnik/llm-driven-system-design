/**
 * @fileoverview Prometheus metrics for observability.
 *
 * Exposes metrics at /metrics endpoint for Prometheus scraping:
 * - WebSocket connection counts
 * - Active documents count
 * - Operation processing latency
 * - OT transform latency
 * - Queue depth (RabbitMQ)
 * - Circuit breaker states
 *
 * Metrics follow Prometheus naming conventions:
 * - Counter: total count, monotonically increasing
 * - Gauge: current value, can go up/down
 * - Histogram: distribution of values with buckets
 */

import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

/**
 * Custom registry for application metrics.
 * Separates app metrics from default Node.js metrics.
 */
export const register = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop)
collectDefaultMetrics({ register });

// ============================================================================
// Connection Metrics
// ============================================================================

/**
 * Total number of active WebSocket connections.
 * Labeled by server_id for multi-instance deployments.
 */
export const wsConnectionsGauge = new Gauge({
  name: 'collab_ws_connections_total',
  help: 'Number of active WebSocket connections',
  labelNames: ['server_id'] as const,
  registers: [register],
});

/**
 * Duration of WebSocket connections.
 * Tracks how long clients stay connected.
 */
export const wsConnectionDuration = new Histogram({
  name: 'collab_ws_connection_duration_seconds',
  help: 'Duration of WebSocket connections in seconds',
  labelNames: ['server_id'] as const,
  buckets: [60, 300, 900, 1800, 3600], // 1min to 1hr
  registers: [register],
});

// ============================================================================
// Document Metrics
// ============================================================================

/**
 * Number of documents with active editors.
 * A document is active if at least one client is connected.
 */
export const activeDocumentsGauge = new Gauge({
  name: 'collab_active_documents',
  help: 'Number of documents with active editors',
  labelNames: ['server_id'] as const,
  registers: [register],
});

/**
 * Total number of collaborators across all active documents.
 */
export const activeCollaboratorsGauge = new Gauge({
  name: 'collab_active_collaborators',
  help: 'Total number of active collaborators across all documents',
  labelNames: ['server_id'] as const,
  registers: [register],
});

// ============================================================================
// Operation Metrics
// ============================================================================

/**
 * Total operations processed.
 * Labeled by status (success, transform_error, apply_error).
 */
export const operationCounter = new Counter({
  name: 'collab_operations_total',
  help: 'Total operations processed',
  labelNames: ['server_id', 'status'] as const,
  registers: [register],
});

/**
 * End-to-end operation processing latency.
 * Time from operation received to acknowledgment sent.
 */
export const operationLatency = new Histogram({
  name: 'collab_operation_latency_ms',
  help: 'Time from operation received to ack sent (milliseconds)',
  labelNames: ['server_id'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

/**
 * Time spent in OT transform function.
 * Labeled by number of concurrent operations transformed against.
 */
export const transformLatency = new Histogram({
  name: 'collab_transform_latency_ms',
  help: 'Time spent in OT transform (milliseconds)',
  labelNames: ['server_id', 'concurrent_ops'] as const,
  buckets: [1, 2, 5, 10, 25, 50, 100],
  registers: [register],
});

/**
 * Sync latency - time for operation to propagate to all clients.
 * Measured from operation received to last broadcast sent.
 */
export const syncLatency = new Histogram({
  name: 'collab_sync_latency_ms',
  help: 'Time to broadcast operation to all clients (milliseconds)',
  labelNames: ['server_id'] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250],
  registers: [register],
});

// ============================================================================
// Queue Metrics
// ============================================================================

/**
 * Number of messages in RabbitMQ queues.
 * High values indicate backlog/backpressure.
 */
export const queueDepthGauge = new Gauge({
  name: 'collab_queue_depth',
  help: 'Number of messages in RabbitMQ queues',
  labelNames: ['queue_name'] as const,
  registers: [register],
});

/**
 * Latency to publish message to RabbitMQ.
 */
export const queuePublishLatency = new Histogram({
  name: 'collab_queue_publish_latency_ms',
  help: 'Time to publish message to RabbitMQ (milliseconds)',
  labelNames: ['exchange'] as const,
  buckets: [1, 5, 10, 25, 50, 100],
  registers: [register],
});

/**
 * Messages published to RabbitMQ.
 */
export const queuePublishCounter = new Counter({
  name: 'collab_queue_publish_total',
  help: 'Total messages published to RabbitMQ',
  labelNames: ['exchange', 'status'] as const,
  registers: [register],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/**
 * Circuit breaker state.
 * 0 = closed (healthy), 1 = open (failing), 0.5 = half-open (testing)
 */
export const circuitBreakerState = new Gauge({
  name: 'collab_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 0.5=half_open, 1=open)',
  labelNames: ['service'] as const,
  registers: [register],
});

/**
 * Circuit breaker trips.
 */
export const circuitBreakerTrips = new Counter({
  name: 'collab_circuit_breaker_trips_total',
  help: 'Total times circuit breaker has tripped',
  labelNames: ['service'] as const,
  registers: [register],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/**
 * Duplicate operations detected and skipped.
 */
export const duplicateOperationsCounter = new Counter({
  name: 'collab_duplicate_operations_total',
  help: 'Total duplicate operations detected and skipped',
  labelNames: ['server_id'] as const,
  registers: [register],
});

// ============================================================================
// Server ID Helper
// ============================================================================

/**
 * Get the current server ID for metrics labels.
 */
export function getServerId(): string {
  return process.env.SERVER_ID || `server-${process.env.PORT || '3001'}`;
}
