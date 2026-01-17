/**
 * Prometheus metrics for monitoring and observability
 * Exports metrics at /metrics endpoint for Prometheus scraping
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { ALERT_THRESHOLDS, CACHE_CONFIG } from './config.js';

// Create a custom registry
export const registry = new Registry();

// Set default labels
registry.setDefaultLabels({
  app: 'youtube_topk',
});

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: registry });

// ============================================
// View Event Metrics
// ============================================

/**
 * Counter: Total number of view events received
 */
export const viewEventsTotal = new Counter({
  name: 'youtube_topk_view_events_total',
  help: 'Total number of view events received',
  labelNames: ['category', 'status'],
  registers: [registry],
});

/**
 * Counter: Duplicate view events (caught by idempotency)
 */
export const duplicateViewEvents = new Counter({
  name: 'youtube_topk_duplicate_views_total',
  help: 'Total number of duplicate view events prevented by idempotency',
  labelNames: ['category'],
  registers: [registry],
});

/**
 * Histogram: View event processing latency
 */
export const viewEventLatency = new Histogram({
  name: 'youtube_topk_view_event_duration_seconds',
  help: 'Time taken to process a view event',
  labelNames: ['category'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

// ============================================
// Top-K Calculation Metrics
// ============================================

/**
 * Counter: Total number of trending calculations
 */
export const trendingCalculationsTotal = new Counter({
  name: 'youtube_topk_trending_calculations_total',
  help: 'Total number of trending calculations performed',
  labelNames: ['category'],
  registers: [registry],
});

/**
 * Histogram: Trending calculation latency
 */
export const trendingCalculationLatency = new Histogram({
  name: 'youtube_topk_trending_calculation_duration_seconds',
  help: 'Time taken to calculate trending videos',
  labelNames: ['category'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/**
 * Gauge: Current number of trending videos
 */
export const trendingVideosCount = new Gauge({
  name: 'youtube_topk_trending_videos_count',
  help: 'Current number of trending videos by category',
  labelNames: ['category'],
  registers: [registry],
});

/**
 * Gauge: Last trending update timestamp
 */
export const lastTrendingUpdate = new Gauge({
  name: 'youtube_topk_last_trending_update_timestamp_seconds',
  help: 'Timestamp of the last trending update',
  labelNames: ['category'],
  registers: [registry],
});

// ============================================
// Heap Operation Metrics
// ============================================

/**
 * Counter: Total heap operations
 */
export const heapOperationsTotal = new Counter({
  name: 'youtube_topk_heap_operations_total',
  help: 'Total number of heap operations',
  labelNames: ['operation'], // push, pop, update, rebuild
  registers: [registry],
});

/**
 * Histogram: Heap operation latency (in microseconds, stored as fractional seconds)
 */
export const heapOperationLatency = new Histogram({
  name: 'youtube_topk_heap_operation_duration_seconds',
  help: 'Time taken for heap operations',
  labelNames: ['operation'],
  buckets: [0.000001, 0.00001, 0.0001, 0.001, 0.01], // 1us to 10ms
  registers: [registry],
});

/**
 * Gauge: Current heap size
 */
export const heapSize = new Gauge({
  name: 'youtube_topk_heap_size',
  help: 'Current size of the min-heap',
  labelNames: ['type'], // main, category-specific
  registers: [registry],
});

// ============================================
// Cache Metrics
// ============================================

/**
 * Counter: Cache hits and misses
 */
export const cacheAccesses = new Counter({
  name: 'youtube_topk_cache_accesses_total',
  help: 'Total number of cache accesses',
  labelNames: ['cache_type', 'result'], // result: hit, miss
  registers: [registry],
});

/**
 * Gauge: Cache hit rate (calculated)
 */
export const cacheHitRate = new Gauge({
  name: 'youtube_topk_cache_hit_rate',
  help: 'Current cache hit rate (0-1)',
  labelNames: ['cache_type'],
  registers: [registry],
});

// Track hits and misses for rate calculation
const cacheStats = {
  trending: { hits: 0, total: 0 },
  metadata: { hits: 0, total: 0 },
};

/**
 * Record a cache access and update hit rate
 * @param {string} cacheType - Type of cache
 * @param {boolean} hit - Whether it was a hit
 */
export function recordCacheAccess(cacheType, hit) {
  const result = hit ? 'hit' : 'miss';
  cacheAccesses.inc({ cache_type: cacheType, result });

  // Update hit rate calculation
  if (cacheStats[cacheType]) {
    cacheStats[cacheType].total++;
    if (hit) cacheStats[cacheType].hits++;

    const rate = cacheStats[cacheType].hits / cacheStats[cacheType].total;
    cacheHitRate.set({ cache_type: cacheType }, rate);
  }
}

// ============================================
// SSE Connection Metrics
// ============================================

/**
 * Gauge: Current number of SSE clients
 */
export const sseClientsConnected = new Gauge({
  name: 'youtube_topk_sse_clients_connected',
  help: 'Current number of connected SSE clients',
  registers: [registry],
});

/**
 * Counter: Total SSE connections
 */
export const sseConnectionsTotal = new Counter({
  name: 'youtube_topk_sse_connections_total',
  help: 'Total number of SSE connection attempts',
  labelNames: ['status'], // connected, disconnected, error
  registers: [registry],
});

// ============================================
// Redis Metrics
// ============================================

/**
 * Gauge: Redis memory usage (bytes)
 */
export const redisMemoryUsage = new Gauge({
  name: 'youtube_topk_redis_memory_bytes',
  help: 'Redis memory usage in bytes',
  registers: [registry],
});

/**
 * Gauge: Redis bucket key count
 */
export const redisBucketKeyCount = new Gauge({
  name: 'youtube_topk_redis_bucket_keys',
  help: 'Number of Redis bucket keys',
  labelNames: ['category'],
  registers: [registry],
});

/**
 * Counter: Redis operations
 */
export const redisOperationsTotal = new Counter({
  name: 'youtube_topk_redis_operations_total',
  help: 'Total number of Redis operations',
  labelNames: ['operation', 'status'], // status: success, error
  registers: [registry],
});

// ============================================
// PostgreSQL Metrics
// ============================================

/**
 * Gauge: PostgreSQL active connections
 */
export const pgActiveConnections = new Gauge({
  name: 'youtube_topk_pg_active_connections',
  help: 'Number of active PostgreSQL connections',
  registers: [registry],
});

/**
 * Histogram: Query latency
 */
export const pgQueryLatency = new Histogram({
  name: 'youtube_topk_pg_query_duration_seconds',
  help: 'PostgreSQL query execution time',
  labelNames: ['query_type'], // select, insert, update
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

/**
 * Gauge: Table row counts
 */
export const tableRowCount = new Gauge({
  name: 'youtube_topk_table_row_count',
  help: 'Number of rows in database tables',
  labelNames: ['table'],
  registers: [registry],
});

// ============================================
// Alert Metrics
// ============================================

/**
 * Gauge: Alert status (0 = OK, 1 = warning, 2 = critical)
 */
export const alertStatus = new Gauge({
  name: 'youtube_topk_alert_status',
  help: 'Current alert status (0=ok, 1=warning, 2=critical)',
  labelNames: ['metric'],
  registers: [registry],
});

/**
 * Update alert status based on current value and thresholds
 * @param {string} metric - Metric name
 * @param {number} value - Current value
 * @param {number} warningThreshold - Warning threshold
 * @param {number} criticalThreshold - Critical threshold
 */
export function updateAlertStatus(metric, value, warningThreshold, criticalThreshold) {
  let status = 0; // OK
  if (value >= criticalThreshold) {
    status = 2; // Critical
  } else if (value >= warningThreshold) {
    status = 1; // Warning
  }
  alertStatus.set({ metric }, status);
}

// ============================================
// HTTP Metrics
// ============================================

/**
 * Counter: HTTP requests
 */
export const httpRequestsTotal = new Counter({
  name: 'youtube_topk_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
  registers: [registry],
});

/**
 * Histogram: HTTP request latency
 */
export const httpRequestLatency = new Histogram({
  name: 'youtube_topk_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'path'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/**
 * Express middleware for HTTP metrics
 */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9; // Convert to seconds
    const path = normalizePath(req.path);

    httpRequestsTotal.inc({
      method: req.method,
      path,
      status_code: res.statusCode,
    });

    httpRequestLatency.observe(
      {
        method: req.method,
        path,
      },
      duration
    );
  });

  next();
}

/**
 * Normalize path for metrics (replace UUIDs with :id)
 * @param {string} path - Request path
 * @returns {string} Normalized path
 */
function normalizePath(path) {
  // Replace UUIDs with :id
  return path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
}

// ============================================
// Health Check Helpers
// ============================================

/**
 * Check if a metric exceeds alert thresholds
 * @param {string} metricName - Name of the metric
 * @param {number} value - Current value
 * @returns {{status: string, value: number, warning: number, critical: number}}
 */
export function checkThreshold(metricName, value) {
  const thresholdMap = {
    redis_memory: {
      warning: ALERT_THRESHOLDS.redisMemoryWarningBytes,
      critical: ALERT_THRESHOLDS.redisMemoryCriticalBytes,
    },
    view_events_rows: {
      warning: ALERT_THRESHOLDS.viewEventsWarningRows,
      critical: ALERT_THRESHOLDS.viewEventsCriticalRows,
    },
    snapshots_rows: {
      warning: ALERT_THRESHOLDS.snapshotsWarningRows,
      critical: ALERT_THRESHOLDS.snapshotsCriticalRows,
    },
    sse_clients: {
      warning: ALERT_THRESHOLDS.sseClientsWarning,
      critical: ALERT_THRESHOLDS.sseClientsCritical,
    },
    view_latency_ms: {
      warning: ALERT_THRESHOLDS.viewRecordingLatencyWarningMs,
      critical: ALERT_THRESHOLDS.viewRecordingLatencyCriticalMs,
    },
    trending_latency_ms: {
      warning: ALERT_THRESHOLDS.trendingQueryLatencyWarningMs,
      critical: ALERT_THRESHOLDS.trendingQueryLatencyCriticalMs,
    },
  };

  const thresholds = thresholdMap[metricName] || { warning: Infinity, critical: Infinity };

  let status = 'ok';
  if (value >= thresholds.critical) {
    status = 'critical';
  } else if (value >= thresholds.warning) {
    status = 'warning';
  }

  return {
    status,
    value,
    warning: thresholds.warning,
    critical: thresholds.critical,
  };
}

/**
 * Get all metrics as string for /metrics endpoint
 * @returns {Promise<string>} Prometheus-formatted metrics
 */
export async function getMetrics() {
  return registry.metrics();
}

/**
 * Get content type for metrics response
 * @returns {string} Content type
 */
export function getContentType() {
  return registry.contentType;
}

export default registry;
