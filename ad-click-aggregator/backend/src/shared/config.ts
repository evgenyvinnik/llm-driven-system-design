/**
 * @fileoverview Centralized configuration for the Ad Click Aggregator.
 * Defines data lifecycle policies, retention periods, alert thresholds,
 * and operational guardrails for capacity management.
 */

/**
 * Data retention configuration defining TTL and archival policies.
 * These values balance analytics requirements against storage costs.
 */
export const RETENTION_CONFIG = {
  /**
   * Raw click events: Keep in hot storage for real-time debugging
   * and fraud investigation. Older data moves to cold storage.
   */
  RAW_CLICKS: {
    /** Days to keep raw clicks in PostgreSQL (hot storage) */
    HOT_STORAGE_DAYS: 7,
    /** Days to keep in compressed format before archival */
    WARM_STORAGE_DAYS: 30,
    /** Years to keep in cold storage (S3/MinIO) for compliance */
    COLD_STORAGE_YEARS: 1,
  },

  /**
   * Aggregation tables: Minute granularity is short-lived,
   * hourly/daily persist longer for historical analysis.
   */
  AGGREGATES: {
    /** Days to keep minute-level aggregates (real-time dashboards) */
    MINUTE_RETENTION_DAYS: 7,
    /** Days to keep hourly aggregates */
    HOUR_RETENTION_DAYS: 365,
    /** Years to keep daily aggregates (indefinite practical limit) */
    DAY_RETENTION_YEARS: 5,
  },

  /**
   * Redis TTL settings for ephemeral data.
   */
  REDIS: {
    /** Seconds for click deduplication keys */
    DEDUP_TTL_SECONDS: 300, // 5 minutes
    /** Seconds for rate limiting windows */
    RATE_LIMIT_TTL_SECONDS: 60, // 1 minute
    /** Seconds for real-time counter expiry */
    REALTIME_COUNTER_TTL_SECONDS: 7200, // 2 hours
    /** Seconds for HyperLogLog unique user tracking */
    HLL_TTL_SECONDS: 7200, // 2 hours
  },
} as const;

/**
 * Alert thresholds for monitoring and capacity guardrails.
 * These trigger Prometheus alerts when exceeded.
 */
export const ALERT_THRESHOLDS = {
  /**
   * Ingestion performance thresholds
   */
  INGESTION: {
    /** Maximum acceptable p95 latency in milliseconds */
    LATENCY_P95_WARNING_MS: 100,
    LATENCY_P95_CRITICAL_MS: 200,
    /** Maximum clicks/second before scaling alert */
    THROUGHPUT_WARNING: 5000,
    THROUGHPUT_CRITICAL: 8000,
    /** Processing backlog threshold (clicks behind) */
    BACKLOG_WARNING: 100,
    BACKLOG_CRITICAL: 500,
  },

  /**
   * Queue lag detection for backpressure alerts
   */
  QUEUE_LAG: {
    /** Maximum acceptable lag in milliseconds */
    LAG_WARNING_MS: 1000,
    LAG_CRITICAL_MS: 5000,
    /** Rate of increase that indicates growing backlog */
    LAG_GROWTH_RATE_PER_MIN_WARNING: 100,
  },

  /**
   * Storage capacity alerts
   */
  STORAGE: {
    /** PostgreSQL database size in bytes */
    DB_SIZE_WARNING_BYTES: 10 * 1024 * 1024 * 1024, // 10GB
    DB_SIZE_CRITICAL_BYTES: 20 * 1024 * 1024 * 1024, // 20GB
    /** Redis memory usage percentage */
    REDIS_MEMORY_PCT_WARNING: 80,
    REDIS_MEMORY_PCT_CRITICAL: 90,
    /** Partition count before cleanup alert */
    PARTITION_COUNT_WARNING: 30,
  },

  /**
   * Cache performance targets
   */
  CACHE: {
    /** Minimum acceptable Redis hit rate percentage */
    HIT_RATE_TARGET_PCT: 95,
    HIT_RATE_WARNING_PCT: 90,
    /** Maximum acceptable deduplication miss rate */
    DEDUP_MISS_RATE_WARNING_PCT: 5,
  },

  /**
   * Fraud detection thresholds
   */
  FRAUD: {
    /** Maximum acceptable fraud rate percentage */
    RATE_WARNING_PCT: 5,
    RATE_CRITICAL_PCT: 10,
    /** Clicks per IP per minute before flagging */
    IP_VELOCITY_THRESHOLD: 100,
    /** Clicks per user per minute before flagging */
    USER_VELOCITY_THRESHOLD: 50,
  },

  /**
   * Database connection pool utilization
   */
  DATABASE: {
    /** Connection pool usage percentage */
    POOL_USAGE_WARNING_PCT: 80,
    POOL_USAGE_CRITICAL_PCT: 90,
    /** Query timeout in milliseconds */
    QUERY_TIMEOUT_WARNING_MS: 1000,
    QUERY_TIMEOUT_CRITICAL_MS: 5000,
  },

  /**
   * HTTP error rate thresholds
   */
  HTTP: {
    /** 5xx error rate percentage */
    ERROR_RATE_WARNING_PCT: 1,
    ERROR_RATE_CRITICAL_PCT: 5,
  },
} as const;

/**
 * SLI/SLO targets for the service
 */
export const SLO_TARGETS = {
  /** Availability SLO (percentage of successful requests) */
  AVAILABILITY_TARGET: 99.9,
  /** Ingestion latency p95 target in milliseconds */
  INGESTION_LATENCY_P95_MS: 50,
  /** Query latency p95 target in milliseconds */
  QUERY_LATENCY_P95_MS: 200,
  /** Deduplication accuracy percentage */
  DEDUP_ACCURACY_TARGET: 99.9,
  /** Cache hit rate target percentage */
  CACHE_HIT_RATE_TARGET: 95,
} as const;

/**
 * Idempotency configuration for exactly-once processing
 */
export const IDEMPOTENCY_CONFIG = {
  /** TTL for idempotency keys in Redis (seconds) */
  KEY_TTL_SECONDS: 300, // 5 minutes - matches dedup TTL
  /** Maximum retries for idempotent operations */
  MAX_RETRIES: 3,
  /** Prefix for idempotency keys in Redis */
  KEY_PREFIX: 'idempotency:',
} as const;

/**
 * Archival configuration for cold storage
 */
export const ARCHIVAL_CONFIG = {
  /** MinIO/S3 bucket name for archived data */
  BUCKET_NAME: process.env.ARCHIVE_BUCKET || 'click-archives',
  /** Base path structure for archived files */
  PATH_TEMPLATE: 'raw/year={year}/month={month}/day={day}/',
  /** File format for archived data */
  FILE_FORMAT: 'parquet' as const,
  /** Compression algorithm */
  COMPRESSION: 'gzip' as const,
  /** Batch size for archival operations */
  BATCH_SIZE: 10000,
} as const;

/**
 * Environment-specific configuration
 */
export const ENV_CONFIG = {
  /** Current environment */
  NODE_ENV: process.env.NODE_ENV || 'development',
  /** Whether to enable verbose logging */
  VERBOSE_LOGGING: process.env.VERBOSE_LOGGING === 'true',
  /** Service name for logging/metrics */
  SERVICE_NAME: 'ad-click-aggregator',
  /** Service version */
  SERVICE_VERSION: process.env.npm_package_version || '1.0.0',
} as const;
