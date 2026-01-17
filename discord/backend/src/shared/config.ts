/**
 * Configuration Module
 *
 * Centralized configuration for Baby Discord server.
 * Includes message retention policies, alert thresholds, and operational parameters.
 *
 * Configuration is loaded from environment variables with sensible defaults
 * for local development. Production deployments should set these via env vars.
 */

// ============================================================================
// Message Retention Policies
// ============================================================================

/**
 * Message retention configuration.
 * Defines how long messages are kept and when cleanup runs.
 *
 * WHY: Without retention policies, storage grows unbounded, leading to:
 * - Increased storage costs
 * - Slower database queries
 * - Potential database performance degradation
 */
export const messageRetention = {
  /**
   * Maximum number of messages to keep per room in the database.
   * Messages beyond this limit are deleted during cleanup.
   */
  maxMessagesPerRoom: parseInt(process.env.MAX_MESSAGES_PER_ROOM || '10', 10),

  /**
   * Maximum age in hours for messages before they become eligible for cleanup.
   * Set to 0 to disable age-based cleanup (only count-based cleanup applies).
   */
  maxMessageAgeHours: parseInt(process.env.MAX_MESSAGE_AGE_HOURS || '0', 10),

  /**
   * Interval in minutes between cleanup job runs.
   * Lower values keep storage tighter but increase DB load.
   */
  cleanupIntervalMinutes: parseInt(process.env.CLEANUP_INTERVAL_MINUTES || '5', 10),

  /**
   * Whether to archive messages to cold storage before deletion.
   * When enabled, messages are exported to JSON files before cleanup.
   */
  archiveBeforeDelete: process.env.ARCHIVE_BEFORE_DELETE === 'true',

  /**
   * Directory for message archives (if archiving is enabled).
   */
  archiveDirectory: process.env.ARCHIVE_DIRECTORY || './archive',
};

// ============================================================================
// Alert Thresholds
// ============================================================================

/**
 * Alert threshold configuration.
 * Defines warning and critical thresholds for monitoring.
 *
 * WHY: Alert thresholds enable proactive monitoring by:
 * - Catching issues before they become outages
 * - Providing early warning of capacity problems
 * - Enabling automated alerting (when integrated with Prometheus/Grafana)
 */
export const alertThresholds = {
  /**
   * Pub/sub latency thresholds in milliseconds.
   * High latency indicates Redis/Valkey overload or network issues.
   */
  pubsubLatency: {
    warning: parseInt(process.env.PUBSUB_LATENCY_WARNING_MS || '100', 10),
    critical: parseInt(process.env.PUBSUB_LATENCY_CRITICAL_MS || '500', 10),
  },

  /**
   * Message queue depth thresholds.
   * High queue depth indicates consumers cannot keep up with producers.
   */
  queueDepth: {
    warning: parseInt(process.env.QUEUE_DEPTH_WARNING || '100', 10),
    critical: parseInt(process.env.QUEUE_DEPTH_CRITICAL || '500', 10),
  },

  /**
   * Database connection wait time thresholds in milliseconds.
   * High wait times indicate connection pool exhaustion.
   */
  dbConnectionWait: {
    warning: parseInt(process.env.DB_WAIT_WARNING_MS || '50', 10),
    critical: parseInt(process.env.DB_WAIT_CRITICAL_MS || '200', 10),
  },

  /**
   * Database table size thresholds in megabytes.
   * Large tables may indicate cleanup job failures.
   */
  tableSize: {
    messages: {
      warning: parseInt(process.env.MESSAGES_TABLE_WARNING_MB || '5', 10),
      critical: parseInt(process.env.MESSAGES_TABLE_CRITICAL_MB || '20', 10),
    },
  },

  /**
   * Cache hit rate thresholds as percentages (0-100).
   * Low cache hit rates indicate potential memory pressure or misconfiguration.
   */
  cacheHitRate: {
    historyBuffer: {
      target: parseInt(process.env.HISTORY_CACHE_TARGET_PCT || '95', 10),
      warning: parseInt(process.env.HISTORY_CACHE_WARNING_PCT || '90', 10),
    },
  },
};

// ============================================================================
// Operational Configuration
// ============================================================================

/**
 * Server configuration.
 */
export const server = {
  /** Instance identifier for multi-instance deployments */
  instanceId: process.env.INSTANCE_ID || '1',

  /** TCP server port */
  tcpPort: parseInt(process.env.TCP_PORT || '9001', 10),

  /** HTTP server port */
  httpPort: parseInt(process.env.HTTP_PORT || '3001', 10),

  /** Log level: debug, info, warn, error */
  logLevel: process.env.LOG_LEVEL || 'info',

  /** Node environment: development, production, test */
  nodeEnv: process.env.NODE_ENV || 'development',
};

/**
 * Database configuration.
 */
export const database = {
  /** PostgreSQL connection URL */
  url: process.env.DATABASE_URL || 'postgresql://discord:discord@localhost:5432/babydiscord',

  /** Maximum connections in the pool */
  poolMax: parseInt(process.env.DB_POOL_MAX || '20', 10),

  /** Idle connection timeout in milliseconds */
  idleTimeout: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),

  /** Connection timeout in milliseconds */
  connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '2000', 10),
};

/**
 * Redis/Valkey configuration.
 */
export const redis = {
  /** Redis connection URL */
  url: process.env.REDIS_URL || 'redis://localhost:6379',

  /** Maximum retry attempts for failed commands */
  maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
};

// ============================================================================
// Graceful Shutdown Configuration
// ============================================================================

/**
 * Shutdown behavior configuration.
 *
 * WHY: Graceful shutdown prevents message loss by:
 * - Allowing in-flight messages to complete
 * - Notifying connected clients before disconnection
 * - Ensuring database writes are flushed
 */
export const shutdown = {
  /**
   * Time in milliseconds to wait for connections to close gracefully.
   * After this timeout, connections are forcibly terminated.
   */
  gracePeriodMs: parseInt(process.env.SHUTDOWN_GRACE_PERIOD_MS || '10000', 10),

  /**
   * Interval for sending shutdown warnings to connected clients.
   */
  warningIntervalMs: parseInt(process.env.SHUTDOWN_WARNING_INTERVAL_MS || '2000', 10),

  /**
   * Whether to drain connections before shutdown.
   * When true, stops accepting new connections but allows existing ones to complete.
   */
  drainConnections: process.env.DRAIN_CONNECTIONS !== 'false',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an alert threshold is exceeded.
 *
 * @param value - Current metric value
 * @param thresholds - Object with warning and critical thresholds
 * @returns 'ok' | 'warning' | 'critical'
 */
export function checkThreshold(
  value: number,
  thresholds: { warning: number; critical: number }
): 'ok' | 'warning' | 'critical' {
  if (value >= thresholds.critical) return 'critical';
  if (value >= thresholds.warning) return 'warning';
  return 'ok';
}

/**
 * Check if a cache hit rate is below threshold.
 * Note: For cache hit rates, lower values are worse.
 *
 * @param hitRate - Cache hit rate as a percentage (0-100)
 * @param thresholds - Object with target and warning thresholds
 * @returns 'ok' | 'warning'
 */
export function checkCacheHitRate(
  hitRate: number,
  thresholds: { target: number; warning: number }
): 'ok' | 'warning' {
  if (hitRate < thresholds.warning) return 'warning';
  return 'ok';
}

export default {
  messageRetention,
  alertThresholds,
  server,
  database,
  redis,
  shutdown,
  checkThreshold,
  checkCacheHitRate,
};
