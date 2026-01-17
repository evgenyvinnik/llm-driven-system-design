/**
 * Prometheus metrics collection for observability.
 * Tracks HTTP requests, uploads, downloads, sync operations, storage metrics,
 * and circuit breaker state.
 * @module shared/metrics
 */

import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';

/** Custom registry for application metrics */
export const registry = new Registry();

/** Default labels applied to all metrics */
registry.setDefaultLabels({
  app: 'dropbox-api',
  env: process.env.NODE_ENV || 'development',
});

/** Enable default metrics collection (memory, cpu, etc.) */
client.collectDefaultMetrics({ register: registry });

// ============================================================================
// HTTP Request Metrics
// ============================================================================

/** Counter for total HTTP requests */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [registry],
});

/** Histogram for HTTP request duration */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'path', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ============================================================================
// Upload Metrics
// ============================================================================

/** Counter for chunk uploads */
export const uploadChunksTotal = new Counter({
  name: 'upload_chunks_total',
  help: 'Total number of chunks uploaded',
  labelNames: ['status'] as const, // success, duplicate, failed
  registers: [registry],
});

/** Counter for upload sessions */
export const uploadSessionsTotal = new Counter({
  name: 'upload_sessions_total',
  help: 'Total number of upload sessions',
  labelNames: ['status'] as const, // created, completed, failed
  registers: [registry],
});

/** Gauge for active upload sessions */
export const uploadSessionsActive = new Gauge({
  name: 'upload_sessions_active',
  help: 'Number of active upload sessions',
  registers: [registry],
});

/** Histogram for upload chunk size */
export const uploadChunkSize = new Histogram({
  name: 'upload_chunk_size_bytes',
  help: 'Size of uploaded chunks in bytes',
  buckets: [1024, 10240, 102400, 1048576, 4194304, 10485760], // 1KB, 10KB, 100KB, 1MB, 4MB, 10MB
  registers: [registry],
});

/** Counter for bytes uploaded */
export const uploadBytesTotal = new Counter({
  name: 'upload_bytes_total',
  help: 'Total bytes uploaded',
  registers: [registry],
});

// ============================================================================
// Download Metrics
// ============================================================================

/** Counter for file downloads */
export const fileDownloadsTotal = new Counter({
  name: 'file_downloads_total',
  help: 'Total number of file downloads',
  labelNames: ['type'] as const, // direct, shared_link
  registers: [registry],
});

/** Counter for bytes downloaded */
export const downloadBytesTotal = new Counter({
  name: 'download_bytes_total',
  help: 'Total bytes downloaded',
  registers: [registry],
});

/** Histogram for download duration */
export const downloadDuration = new Histogram({
  name: 'download_duration_seconds',
  help: 'Duration of file downloads in seconds',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

// ============================================================================
// Sync Metrics
// ============================================================================

/** Counter for sync events published */
export const syncEventsTotal = new Counter({
  name: 'sync_events_total',
  help: 'Total number of sync events published',
  labelNames: ['type'] as const, // file_created, file_updated, file_deleted, item_moved, item_renamed
  registers: [registry],
});

/** Gauge for active WebSocket connections */
export const websocketConnectionsActive = new Gauge({
  name: 'websocket_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [registry],
});

/** Histogram for sync event latency (publish to delivery) */
export const syncLatency = new Histogram({
  name: 'sync_latency_seconds',
  help: 'Latency of sync event delivery in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

// ============================================================================
// Storage Metrics
// ============================================================================

/** Gauge for storage used per user (sampled) */
export const storageUsedBytes = new Gauge({
  name: 'storage_used_bytes',
  help: 'Storage used in bytes (aggregate)',
  registers: [registry],
});

/** Counter for deduplication events */
export const deduplicationTotal = new Counter({
  name: 'deduplication_total',
  help: 'Total number of deduplicated chunks',
  registers: [registry],
});

/** Gauge for deduplication ratio */
export const deduplicationRatio = new Gauge({
  name: 'deduplication_ratio',
  help: 'Current deduplication ratio (0-1)',
  registers: [registry],
});

// ============================================================================
// Circuit Breaker Metrics
// ============================================================================

/** Gauge for circuit breaker state */
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state: 0=closed, 1=open, 2=half-open',
  labelNames: ['name'] as const,
  registers: [registry],
});

/** Counter for circuit breaker state changes */
export const circuitBreakerTransitions = new Counter({
  name: 'circuit_breaker_transitions_total',
  help: 'Total number of circuit breaker state transitions',
  labelNames: ['name', 'from', 'to'] as const,
  registers: [registry],
});

/** Counter for circuit breaker rejections */
export const circuitBreakerRejections = new Counter({
  name: 'circuit_breaker_rejections_total',
  help: 'Total number of requests rejected by circuit breaker',
  labelNames: ['name'] as const,
  registers: [registry],
});

// ============================================================================
// Retry Metrics
// ============================================================================

/** Counter for retry attempts */
export const retryAttemptsTotal = new Counter({
  name: 'retry_attempts_total',
  help: 'Total number of retry attempts',
  labelNames: ['operation', 'attempt'] as const,
  registers: [registry],
});

/** Counter for successful retries */
export const retrySuccessTotal = new Counter({
  name: 'retry_success_total',
  help: 'Total number of successful retries',
  labelNames: ['operation', 'attempts'] as const,
  registers: [registry],
});

/** Counter for failed operations after all retries */
export const retryExhaustedTotal = new Counter({
  name: 'retry_exhausted_total',
  help: 'Total number of operations that failed after all retries',
  labelNames: ['operation'] as const,
  registers: [registry],
});

// ============================================================================
// File Operation Metrics
// ============================================================================

/** Counter for file operations */
export const fileOperationsTotal = new Counter({
  name: 'file_operations_total',
  help: 'Total number of file operations',
  labelNames: ['operation', 'status'] as const, // upload, download, delete, rename, move, restore
  registers: [registry],
});

/** Counter for folder operations */
export const folderOperationsTotal = new Counter({
  name: 'folder_operations_total',
  help: 'Total number of folder operations',
  labelNames: ['operation', 'status'] as const, // create, delete, rename, move
  registers: [registry],
});

// ============================================================================
// Idempotency Metrics
// ============================================================================

/** Counter for idempotency cache hits */
export const idempotencyCacheHits = new Counter({
  name: 'idempotency_cache_hits_total',
  help: 'Total number of idempotency cache hits (duplicate requests)',
  labelNames: ['operation'] as const,
  registers: [registry],
});

/** Counter for idempotency cache misses */
export const idempotencyCacheMisses = new Counter({
  name: 'idempotency_cache_misses_total',
  help: 'Total number of idempotency cache misses (new requests)',
  labelNames: ['operation'] as const,
  registers: [registry],
});

// ============================================================================
// Export metrics endpoint handler
// ============================================================================

/**
 * Returns Prometheus metrics in text format.
 * Use with GET /metrics endpoint.
 */
export async function getMetrics(): Promise<string> {
  return registry.metrics();
}

/**
 * Returns content type for metrics response
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}

export default registry;
