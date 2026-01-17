/**
 * Prometheus metrics for monitoring collaborative editing.
 * Exposes /metrics endpoint for Prometheus scraping.
 * Tracks active collaborators, sync latency, operation throughput, and health.
 */
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Custom registry for application metrics.
 * Prevents conflicts with default metrics from other packages.
 */
export const metricsRegistry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

/**
 * Gauge tracking active collaborators per file.
 * Updated when users subscribe/unsubscribe from files.
 * Label: file_id - The design file identifier
 */
export const activeCollaboratorsGauge = new Gauge({
  name: 'figma_active_collaborators',
  help: 'Number of active collaborators per file',
  labelNames: ['file_id'],
  registers: [metricsRegistry],
});

/**
 * Gauge tracking total WebSocket connections.
 * Useful for capacity planning and load balancing decisions.
 */
export const totalConnectionsGauge = new Gauge({
  name: 'figma_websocket_connections_total',
  help: 'Total number of active WebSocket connections',
  registers: [metricsRegistry],
});

/**
 * Counter tracking design operations by type.
 * Labels: operation_type (create, update, delete, move), status (success, error)
 */
export const operationsCounter = new Counter({
  name: 'figma_operations_total',
  help: 'Total number of design operations processed',
  labelNames: ['operation_type', 'status'],
  registers: [metricsRegistry],
});

/**
 * Histogram measuring operation processing latency.
 * Buckets optimized for real-time collaboration (fast operations expected).
 */
export const operationLatencyHistogram = new Histogram({
  name: 'figma_operation_latency_seconds',
  help: 'Time taken to process design operations',
  labelNames: ['operation_type'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});

/**
 * Histogram measuring sync message latency.
 * Tracks time to broadcast operations to collaborators.
 */
export const syncLatencyHistogram = new Histogram({
  name: 'figma_sync_latency_seconds',
  help: 'Time taken to sync operations to collaborators',
  labelNames: ['message_type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [metricsRegistry],
});

/**
 * Counter tracking idempotency cache behavior.
 * Labels: result (processed, deduplicated)
 */
export const idempotencyCounter = new Counter({
  name: 'figma_idempotency_checks_total',
  help: 'Number of idempotency key checks',
  labelNames: ['result'],
  registers: [metricsRegistry],
});

/**
 * Counter tracking circuit breaker state transitions.
 * Labels: circuit (postgres, redis, etc.), state (open, closed, half_open)
 */
export const circuitBreakerCounter = new Counter({
  name: 'figma_circuit_breaker_transitions_total',
  help: 'Number of circuit breaker state transitions',
  labelNames: ['circuit', 'state'],
  registers: [metricsRegistry],
});

/**
 * Gauge tracking current circuit breaker states.
 * 0 = closed (healthy), 1 = open (failing), 2 = half-open (testing)
 */
export const circuitBreakerStateGauge = new Gauge({
  name: 'figma_circuit_breaker_state',
  help: 'Current circuit breaker state (0=closed, 1=open, 2=half_open)',
  labelNames: ['circuit'],
  registers: [metricsRegistry],
});

/**
 * Counter tracking retry attempts.
 * Labels: operation, attempt
 */
export const retryCounter = new Counter({
  name: 'figma_retry_attempts_total',
  help: 'Number of retry attempts for operations',
  labelNames: ['operation', 'attempt'],
  registers: [metricsRegistry],
});

/**
 * Histogram tracking database query latency.
 * Labels: query_type (select, insert, update, delete)
 */
export const dbLatencyHistogram = new Histogram({
  name: 'figma_db_query_latency_seconds',
  help: 'Database query execution time',
  labelNames: ['query_type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

/**
 * Gauge tracking version count per file.
 * Useful for monitoring version history retention.
 */
export const fileVersionsGauge = new Gauge({
  name: 'figma_file_versions',
  help: 'Number of versions per file',
  labelNames: ['file_id', 'type'],
  registers: [metricsRegistry],
});

/**
 * Counter tracking cleanup job executions.
 * Labels: job_type (auto_save_cleanup, operations_cleanup)
 */
export const cleanupJobCounter = new Counter({
  name: 'figma_cleanup_jobs_total',
  help: 'Number of cleanup job executions',
  labelNames: ['job_type', 'status'],
  registers: [metricsRegistry],
});

/**
 * Gets the metrics in Prometheus text format.
 * @returns Promise resolving to metrics string
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Gets the content type for Prometheus metrics.
 * @returns Content-Type header value
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}

export default metricsRegistry;
