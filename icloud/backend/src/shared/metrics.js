/**
 * Prometheus metrics for observability
 *
 * WHY: Metrics enable monitoring, alerting, and capacity planning. Prometheus
 * provides a standard format that integrates with Grafana dashboards. We track
 * key SLIs (sync latency, error rates, cache hit rates) to ensure service health.
 */

import client from 'prom-client';

// Create a custom registry to avoid default metrics conflicts
export const registry = new client.Registry();

// Add default Node.js metrics (memory, CPU, event loop lag)
client.collectDefaultMetrics({ register: registry });

// =============================================================================
// HTTP Request Metrics
// =============================================================================

export const httpRequestDuration = new client.Histogram({
  name: 'icloud_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'icloud_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

// =============================================================================
// Sync Metrics
// =============================================================================

export const syncDuration = new client.Histogram({
  name: 'icloud_sync_duration_seconds',
  help: 'Duration of sync operations in seconds',
  labelNames: ['operation', 'result'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const syncOperationsTotal = new client.Counter({
  name: 'icloud_sync_operations_total',
  help: 'Total number of sync operations',
  labelNames: ['operation', 'result'],
  registers: [registry],
});

export const conflictsTotal = new client.Counter({
  name: 'icloud_conflicts_total',
  help: 'Total number of sync conflicts detected',
  labelNames: ['conflict_type', 'resolution'],
  registers: [registry],
});

// =============================================================================
// Storage Metrics
// =============================================================================

export const chunkOperationDuration = new client.Histogram({
  name: 'icloud_chunk_operation_duration_seconds',
  help: 'Duration of chunk storage operations',
  labelNames: ['operation'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

export const dedupHitsTotal = new client.Counter({
  name: 'icloud_dedup_hits_total',
  help: 'Number of chunks skipped due to deduplication',
  registers: [registry],
});

export const bytesUploaded = new client.Counter({
  name: 'icloud_bytes_uploaded_total',
  help: 'Total bytes uploaded to storage',
  registers: [registry],
});

export const bytesDownloaded = new client.Counter({
  name: 'icloud_bytes_downloaded_total',
  help: 'Total bytes downloaded from storage',
  registers: [registry],
});

// =============================================================================
// Cache Metrics
// =============================================================================

export const cacheHits = new client.Counter({
  name: 'icloud_cache_hits_total',
  help: 'Number of cache hits',
  labelNames: ['cache_type'],
  registers: [registry],
});

export const cacheMisses = new client.Counter({
  name: 'icloud_cache_misses_total',
  help: 'Number of cache misses',
  labelNames: ['cache_type'],
  registers: [registry],
});

// =============================================================================
// Circuit Breaker Metrics
// =============================================================================

export const circuitBreakerState = new client.Gauge({
  name: 'icloud_circuit_breaker_state',
  help: 'Current state of circuit breakers (0=closed, 1=open, 2=half-open)',
  labelNames: ['breaker_name'],
  registers: [registry],
});

export const circuitBreakerFailures = new client.Counter({
  name: 'icloud_circuit_breaker_failures_total',
  help: 'Total failures that triggered circuit breaker',
  labelNames: ['breaker_name'],
  registers: [registry],
});

// =============================================================================
// WebSocket Metrics
// =============================================================================

export const websocketConnections = new client.Gauge({
  name: 'icloud_websocket_connections',
  help: 'Current number of active WebSocket connections',
  registers: [registry],
});

// =============================================================================
// Express Middleware
// =============================================================================

/**
 * Middleware to track HTTP request metrics
 */
export function metricsMiddleware(req, res, next) {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
}

/**
 * Metrics endpoint handler for Prometheus scraping
 */
export async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Timer helper for measuring operation duration
 */
export function startTimer(histogram, labels = {}) {
  const startTime = Date.now();
  return {
    end: (extraLabels = {}) => {
      const duration = (Date.now() - startTime) / 1000;
      histogram.observe({ ...labels, ...extraLabels }, duration);
      return duration;
    },
  };
}

export default {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  syncDuration,
  syncOperationsTotal,
  conflictsTotal,
  chunkOperationDuration,
  dedupHitsTotal,
  bytesUploaded,
  bytesDownloaded,
  cacheHits,
  cacheMisses,
  circuitBreakerState,
  circuitBreakerFailures,
  websocketConnections,
  metricsMiddleware,
  metricsHandler,
  startTimer,
};
