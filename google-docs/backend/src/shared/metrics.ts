/**
 * Prometheus metrics for monitoring and observability.
 * Tracks active documents, collaborators, sync latency, and request performance.
 * Exposes /metrics endpoint for Prometheus scraping.
 */

import client from 'prom-client';

/** Create a Registry to register metrics */
export const register = new client.Registry();

/** Add default metrics (CPU, memory, event loop lag, etc.) */
client.collectDefaultMetrics({ register });

// ============= COLLABORATION METRICS =============

/**
 * Gauge: Number of documents currently being actively edited.
 * Helps understand real-time load and when to scale.
 */
export const activeDocumentsGauge = new client.Gauge({
  name: 'google_docs_active_documents_total',
  help: 'Number of documents with active WebSocket connections',
  registers: [register],
});

/**
 * Gauge: Number of collaborators currently connected across all documents.
 * Each WebSocket connection counts as one collaborator.
 */
export const activeCollaboratorsGauge = new client.Gauge({
  name: 'google_docs_active_collaborators_total',
  help: 'Total number of active WebSocket connections (collaborators)',
  registers: [register],
});

/**
 * Histogram: OT operation sync latency in milliseconds.
 * Measures time from receiving operation to broadcasting to all clients.
 * Critical for UX - users notice lag above 100ms.
 */
export const syncLatencyHistogram = new client.Histogram({
  name: 'google_docs_sync_latency_ms',
  help: 'Latency for OT operation sync (receive to broadcast) in milliseconds',
  labelNames: ['operation_type'] as const,
  buckets: [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1000],
  registers: [register],
});

/**
 * Counter: Total OT operations processed by type.
 * Tracks insert, delete, format, and retain operations.
 */
export const operationsCounter = new client.Counter({
  name: 'google_docs_operations_total',
  help: 'Total number of OT operations processed',
  labelNames: ['operation_type'] as const,
  registers: [register],
});

/**
 * Counter: OT conflicts detected and resolved.
 * High conflict rate may indicate poor network conditions or design issues.
 */
export const conflictsCounter = new client.Counter({
  name: 'google_docs_conflicts_total',
  help: 'Total number of OT conflicts detected and resolved',
  registers: [register],
});

// ============= HTTP METRICS =============

/**
 * Histogram: HTTP request duration in seconds.
 * Labeled by method, route, and status code.
 */
export const httpRequestDurationHistogram = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Counter: Total HTTP requests by method, route, and status.
 */
export const httpRequestsCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

// ============= CACHE METRICS =============

/**
 * Counter: Cache operations (hits and misses).
 * Useful for tuning cache TTLs and identifying hot paths.
 */
export const cacheCounter = new client.Counter({
  name: 'google_docs_cache_total',
  help: 'Cache hits and misses',
  labelNames: ['cache_name', 'result'] as const,
  registers: [register],
});

// ============= CIRCUIT BREAKER METRICS =============

/**
 * Gauge: Circuit breaker state (0=closed, 1=open, 2=half-open).
 * Helps identify when fallback behavior is active.
 */
export const circuitBreakerStateGauge = new client.Gauge({
  name: 'google_docs_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['circuit_name'] as const,
  registers: [register],
});

/**
 * Counter: Circuit breaker events (success, failure, timeout, rejected).
 */
export const circuitBreakerEventsCounter = new client.Counter({
  name: 'google_docs_circuit_breaker_events_total',
  help: 'Circuit breaker events',
  labelNames: ['circuit_name', 'event'] as const,
  registers: [register],
});

// ============= DATABASE METRICS =============

/**
 * Histogram: Database query duration in seconds.
 */
export const dbQueryDurationHistogram = new client.Histogram({
  name: 'google_docs_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['query_type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// ============= IDEMPOTENCY METRICS =============

/**
 * Counter: Idempotency key hits (duplicate requests detected).
 */
export const idempotencyHitsCounter = new client.Counter({
  name: 'google_docs_idempotency_hits_total',
  help: 'Number of duplicate requests detected via idempotency keys',
  registers: [register],
});

/**
 * Helper function to record HTTP request metrics.
 */
export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number
): void {
  httpRequestDurationHistogram.observe({ method, route, status_code: String(statusCode) }, durationSeconds);
  httpRequestsCounter.inc({ method, route, status_code: String(statusCode) });
}

/**
 * Helper to record cache access.
 */
export function recordCacheAccess(cacheName: string, hit: boolean): void {
  cacheCounter.inc({ cache_name: cacheName, result: hit ? 'hit' : 'miss' });
}

/**
 * Helper to record sync latency.
 */
export function recordSyncLatency(operationType: string, latencyMs: number): void {
  syncLatencyHistogram.observe({ operation_type: operationType }, latencyMs);
}

export default register;
