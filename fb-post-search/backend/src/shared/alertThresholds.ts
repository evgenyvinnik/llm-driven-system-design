/**
 * @fileoverview Alert threshold constants for monitoring and capacity planning.
 * Defines warning and critical thresholds for key operational metrics.
 * Used by alerting systems (Prometheus/Alertmanager) and health checks.
 */

/**
 * Search performance thresholds.
 * Based on SLA targets: p99 < 200ms, p95 < 100ms.
 */
export const SEARCH_THRESHOLDS = {
  /** Warning threshold for p95 latency (seconds) */
  LATENCY_P95_WARNING: 0.3,
  /** Critical threshold for p95 latency (seconds) */
  LATENCY_P95_CRITICAL: 0.5,
  /** Warning threshold for p99 latency (seconds) */
  LATENCY_P99_WARNING: 0.5,
  /** Critical threshold for p99 latency (seconds) */
  LATENCY_P99_CRITICAL: 1.0,
  /** Minimum acceptable cache hit rate (percentage) */
  CACHE_HIT_RATE_WARNING: 0.8,
  /** Critical cache hit rate threshold */
  CACHE_HIT_RATE_CRITICAL: 0.6,
} as const;

/**
 * Elasticsearch cluster thresholds.
 */
export const ELASTICSEARCH_THRESHOLDS = {
  /** Warning threshold for JVM heap usage (percentage) */
  HEAP_USAGE_WARNING: 0.7,
  /** Critical threshold for JVM heap usage (percentage) */
  HEAP_USAGE_CRITICAL: 0.85,
  /** Warning threshold for disk usage (percentage) */
  DISK_USAGE_WARNING: 0.75,
  /** Critical threshold for disk usage (percentage) */
  DISK_USAGE_CRITICAL: 0.85,
  /** Maximum acceptable query latency for ES queries (seconds) */
  QUERY_LATENCY_WARNING: 0.5,
  /** Critical ES query latency threshold (seconds) */
  QUERY_LATENCY_CRITICAL: 2.0,
} as const;

/**
 * Indexing lag thresholds.
 * Time between post creation and searchability.
 */
export const INDEXING_THRESHOLDS = {
  /** Warning threshold for indexing lag p99 (seconds) */
  LAG_P99_WARNING: 5,
  /** Critical threshold for indexing lag p99 (seconds) */
  LAG_P99_CRITICAL: 30,
  /** Warning threshold for Kafka consumer lag (messages) */
  CONSUMER_LAG_WARNING: 10000,
  /** Critical threshold for Kafka consumer lag (messages) */
  CONSUMER_LAG_CRITICAL: 100000,
} as const;

/**
 * PostgreSQL connection thresholds.
 */
export const POSTGRES_THRESHOLDS = {
  /** Warning threshold for connection pool usage (count) */
  CONNECTIONS_WARNING: 80,
  /** Critical threshold for connection pool usage (count) */
  CONNECTIONS_CRITICAL: 95,
  /** Max connections in pool */
  MAX_CONNECTIONS: 100,
  /** Warning threshold for query latency (seconds) */
  QUERY_LATENCY_WARNING: 0.1,
  /** Critical threshold for query latency (seconds) */
  QUERY_LATENCY_CRITICAL: 1.0,
} as const;

/**
 * Redis memory thresholds.
 */
export const REDIS_THRESHOLDS = {
  /** Warning threshold for memory usage (percentage) */
  MEMORY_USAGE_WARNING: 0.7,
  /** Critical threshold for memory usage (percentage) */
  MEMORY_USAGE_CRITICAL: 0.85,
  /** Target cache hit rate for visibility sets */
  VISIBILITY_CACHE_HIT_TARGET: 0.9,
  /** Target cache hit rate for suggestions */
  SUGGESTIONS_CACHE_HIT_TARGET: 0.85,
  /** Target cache hit rate for user profiles */
  USER_PROFILE_CACHE_HIT_TARGET: 0.95,
} as const;

/**
 * Error rate thresholds.
 */
export const ERROR_THRESHOLDS = {
  /** Warning threshold for error rate (percentage) */
  ERROR_RATE_WARNING: 0.005,
  /** Critical threshold for error rate (percentage) */
  ERROR_RATE_CRITICAL: 0.02,
  /** Warning threshold for 5xx error rate */
  SERVER_ERROR_RATE_WARNING: 0.001,
  /** Critical threshold for 5xx error rate */
  SERVER_ERROR_RATE_CRITICAL: 0.01,
} as const;

/**
 * Circuit breaker thresholds.
 */
export const CIRCUIT_BREAKER_THRESHOLDS = {
  /** Number of failures before opening circuit */
  FAILURE_THRESHOLD: 5,
  /** Time to wait before attempting recovery (ms) */
  RESET_TIMEOUT_MS: 30000,
  /** Number of consecutive successes to close circuit */
  SUCCESS_THRESHOLD: 3,
  /** Request timeout before counting as failure (ms) */
  REQUEST_TIMEOUT_MS: 5000,
} as const;

/**
 * Data retention thresholds.
 */
export const RETENTION_THRESHOLDS = {
  /** Hot tier retention for Elasticsearch index (days) */
  ES_HOT_TIER_DAYS: 60,
  /** Warm tier retention for Elasticsearch index (days) */
  ES_WARM_TIER_DAYS: 730,
  /** Cold tier retention (freeze) for Elasticsearch (days) */
  ES_COLD_TIER_DAYS: 1825,
  /** Search history retention (days) */
  SEARCH_HISTORY_DAYS: 90,
  /** Session data TTL (seconds) */
  SESSION_TTL_SECONDS: 86400,
  /** Visibility cache TTL (seconds) */
  VISIBILITY_CACHE_TTL_SECONDS: 900,
  /** Search suggestions cache TTL (seconds) */
  SUGGESTIONS_CACHE_TTL_SECONDS: 3600,
} as const;

/**
 * Local development resource limits.
 * These are advisory for docker-compose resource constraints.
 */
export const LOCAL_DEV_LIMITS = {
  /** Max memory for Elasticsearch (bytes) */
  ES_MEMORY_BYTES: 2 * 1024 * 1024 * 1024, // 2GB
  /** Max memory for PostgreSQL (bytes) */
  POSTGRES_MEMORY_BYTES: 512 * 1024 * 1024, // 512MB
  /** Max memory for Redis (bytes) */
  REDIS_MEMORY_BYTES: 256 * 1024 * 1024, // 256MB
  /** Expected daily index growth for local dev (bytes) */
  DAILY_INDEX_GROWTH_BYTES: 50 * 1024 * 1024, // 50MB
} as const;

/**
 * Prometheus alert rule generator helpers.
 * These return PromQL expressions for alerting.
 */
export const alertExpressions = {
  /**
   * Generates PromQL for high search latency alert.
   * @param percentile - 95 or 99
   * @param threshold - Latency threshold in seconds
   */
  highSearchLatency: (percentile: 95 | 99, threshold: number): string =>
    `histogram_quantile(0.${percentile}, rate(search_latency_seconds_bucket[5m])) > ${threshold}`,

  /**
   * Generates PromQL for low cache hit rate alert.
   * @param cacheType - Cache type to check
   * @param threshold - Minimum hit rate (0-1)
   */
  lowCacheHitRate: (cacheType: string, threshold: number): string =>
    `rate(cache_hits_total{cache_type="${cacheType}"}[5m]) / (rate(cache_hits_total{cache_type="${cacheType}"}[5m]) + rate(cache_misses_total{cache_type="${cacheType}"}[5m])) < ${threshold}`,

  /**
   * Generates PromQL for high error rate alert.
   * @param threshold - Error rate threshold (0-1)
   */
  highErrorRate: (threshold: number): string =>
    `rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m]) > ${threshold}`,

  /**
   * Generates PromQL for circuit breaker open alert.
   * @param service - Service name
   */
  circuitBreakerOpen: (service: string): string =>
    `circuit_breaker_state{service="${service}"} == 1`,
};
