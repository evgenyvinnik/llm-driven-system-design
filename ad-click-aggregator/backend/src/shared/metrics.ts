/**
 * @fileoverview Prometheus metrics for the Ad Click Aggregator.
 * Exposes key operational metrics for monitoring ingestion throughput,
 * queue lag, aggregation accuracy, and system health.
 */

import client from 'prom-client';
import { ALERT_THRESHOLDS, ENV_CONFIG } from './config.js';

// Create a Registry to register metrics
const register = new client.Registry();

// Add default labels
register.setDefaultLabels({
  service: ENV_CONFIG.SERVICE_NAME,
  env: ENV_CONFIG.NODE_ENV,
});

// Collect default metrics (CPU, memory, event loop, etc.)
client.collectDefaultMetrics({ register });

/**
 * Click ingestion metrics
 */
export const clickMetrics = {
  /**
   * Total clicks received (before dedup/fraud filtering)
   */
  received: new client.Counter({
    name: 'clicks_received_total',
    help: 'Total number of click events received',
    labelNames: ['source'],
    registers: [register],
  }),

  /**
   * Successfully processed clicks (stored and aggregated)
   */
  processed: new client.Counter({
    name: 'clicks_processed_total',
    help: 'Total number of clicks successfully processed',
    labelNames: ['campaign_id'],
    registers: [register],
  }),

  /**
   * Duplicate clicks detected and skipped
   */
  duplicates: new client.Counter({
    name: 'clicks_deduplicated_total',
    help: 'Total number of duplicate clicks detected',
    registers: [register],
  }),

  /**
   * Fraudulent clicks detected
   */
  fraud: new client.Counter({
    name: 'clicks_fraud_detected_total',
    help: 'Total number of fraudulent clicks detected',
    labelNames: ['reason'],
    registers: [register],
  }),

  /**
   * Ingestion latency histogram
   */
  latency: new client.Histogram({
    name: 'click_ingestion_duration_seconds',
    help: 'Click ingestion latency in seconds',
    labelNames: ['status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  }),

  /**
   * Current queue size (for backpressure detection)
   */
  queueSize: new client.Gauge({
    name: 'click_queue_size',
    help: 'Current number of clicks in processing queue',
    registers: [register],
  }),

  /**
   * Queue lag in milliseconds
   */
  queueLag: new client.Gauge({
    name: 'click_queue_lag_ms',
    help: 'Processing lag in milliseconds (oldest unprocessed click age)',
    registers: [register],
  }),
};

/**
 * Aggregation metrics
 */
export const aggregationMetrics = {
  /**
   * Aggregation updates by granularity
   */
  updates: new client.Counter({
    name: 'aggregation_updates_total',
    help: 'Total number of aggregation table updates',
    labelNames: ['granularity'],
    registers: [register],
  }),

  /**
   * Aggregation update latency
   */
  latency: new client.Histogram({
    name: 'aggregation_update_duration_seconds',
    help: 'Aggregation update latency in seconds',
    labelNames: ['granularity'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: [register],
  }),

  /**
   * Aggregation errors
   */
  errors: new client.Counter({
    name: 'aggregation_errors_total',
    help: 'Total number of aggregation update errors',
    labelNames: ['granularity', 'error_type'],
    registers: [register],
  }),
};

/**
 * Database metrics
 */
export const dbMetrics = {
  /**
   * Database query latency
   */
  queryLatency: new client.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Database query latency in seconds',
    labelNames: ['operation', 'table'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
  }),

  /**
   * Database connection pool size
   */
  poolSize: new client.Gauge({
    name: 'db_pool_size',
    help: 'Current database connection pool size',
    labelNames: ['state'],
    registers: [register],
  }),

  /**
   * Database errors
   */
  errors: new client.Counter({
    name: 'db_errors_total',
    help: 'Total number of database errors',
    labelNames: ['operation', 'error_type'],
    registers: [register],
  }),
};

/**
 * Redis/Cache metrics
 */
export const cacheMetrics = {
  /**
   * Cache hits
   */
  hits: new client.Counter({
    name: 'cache_hits_total',
    help: 'Total number of cache hits',
    labelNames: ['operation'],
    registers: [register],
  }),

  /**
   * Cache misses
   */
  misses: new client.Counter({
    name: 'cache_misses_total',
    help: 'Total number of cache misses',
    labelNames: ['operation'],
    registers: [register],
  }),

  /**
   * Redis operation latency
   */
  latency: new client.Histogram({
    name: 'redis_operation_duration_seconds',
    help: 'Redis operation latency in seconds',
    labelNames: ['operation'],
    buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05],
    registers: [register],
  }),

  /**
   * Redis memory usage
   */
  memoryUsage: new client.Gauge({
    name: 'redis_memory_used_bytes',
    help: 'Redis memory usage in bytes',
    registers: [register],
  }),

  /**
   * Redis errors
   */
  errors: new client.Counter({
    name: 'redis_errors_total',
    help: 'Total number of Redis errors',
    labelNames: ['operation', 'error_type'],
    registers: [register],
  }),
};

/**
 * HTTP request metrics
 */
export const httpMetrics = {
  /**
   * HTTP request count
   */
  requests: new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'path', 'status'],
    registers: [register],
  }),

  /**
   * HTTP request latency
   */
  latency: new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'path'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
  }),

  /**
   * Currently active requests
   */
  activeRequests: new client.Gauge({
    name: 'http_active_requests',
    help: 'Number of currently active HTTP requests',
    registers: [register],
  }),
};

/**
 * Alert threshold gauges for dashboard visibility
 */
export const thresholdGauges = {
  ingestionLatencyWarning: new client.Gauge({
    name: 'alert_threshold_ingestion_latency_warning_ms',
    help: 'Configured warning threshold for ingestion latency',
    registers: [register],
  }),

  queueLagWarning: new client.Gauge({
    name: 'alert_threshold_queue_lag_warning_ms',
    help: 'Configured warning threshold for queue lag',
    registers: [register],
  }),

  cacheHitRateTarget: new client.Gauge({
    name: 'alert_threshold_cache_hit_rate_target_pct',
    help: 'Configured target for cache hit rate percentage',
    registers: [register],
  }),

  fraudRateWarning: new client.Gauge({
    name: 'alert_threshold_fraud_rate_warning_pct',
    help: 'Configured warning threshold for fraud rate percentage',
    registers: [register],
  }),
};

// Initialize threshold gauges with configured values
thresholdGauges.ingestionLatencyWarning.set(ALERT_THRESHOLDS.INGESTION.LATENCY_P95_WARNING_MS);
thresholdGauges.queueLagWarning.set(ALERT_THRESHOLDS.QUEUE_LAG.LAG_WARNING_MS);
thresholdGauges.cacheHitRateTarget.set(ALERT_THRESHOLDS.CACHE.HIT_RATE_TARGET_PCT);
thresholdGauges.fraudRateWarning.set(ALERT_THRESHOLDS.FRAUD.RATE_WARNING_PCT);

/**
 * Health check metrics
 */
export const healthMetrics = {
  /**
   * Service health status (1 = healthy, 0 = unhealthy)
   */
  status: new client.Gauge({
    name: 'service_health_status',
    help: 'Service health status (1=healthy, 0=unhealthy)',
    labelNames: ['component'],
    registers: [register],
  }),

  /**
   * Last successful health check timestamp
   */
  lastCheck: new client.Gauge({
    name: 'service_last_health_check_timestamp',
    help: 'Timestamp of last successful health check',
    registers: [register],
  }),
};

/**
 * Returns the metrics registry for the /metrics endpoint.
 */
export function getMetricsRegistry(): client.Registry {
  return register;
}

/**
 * Returns metrics in Prometheus text format for the /metrics endpoint.
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

/**
 * Helper to time async operations and record to histogram
 */
export async function timeAsync<T>(
  histogram: client.Histogram<string>,
  labels: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  const end = histogram.startTimer(labels);
  try {
    const result = await fn();
    end();
    return result;
  } catch (error) {
    end();
    throw error;
  }
}

/**
 * Calculate and return cache hit rate
 */
export function getCacheHitRate(): number {
  // This is a simplified version - in production you'd track this over a window
  const hits = (cacheMetrics.hits as client.Counter<string>).hashMap;
  const misses = (cacheMetrics.misses as client.Counter<string>).hashMap;

  // Note: This is approximate - for accurate rates, use Prometheus queries
  return 0; // Placeholder - actual rate calculated in Prometheus
}

export default register;
