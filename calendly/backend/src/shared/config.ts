/**
 * Application configuration constants and environment settings.
 * Centralizes all configurable values for easy management.
 */

// ============================================================================
// DATA RETENTION POLICIES
// ============================================================================

/**
 * Meeting/booking retention configuration.
 * Defines how long different types of booking data are kept.
 */
export const RETENTION_CONFIG = {
  /**
   * Days to keep completed bookings in the active table.
   * After this period, bookings are moved to the archive table.
   */
  COMPLETED_BOOKING_RETENTION_DAYS: parseInt(
    process.env.COMPLETED_BOOKING_RETENTION_DAYS || '90'
  ),

  /**
   * Days to keep cancelled bookings in the active table.
   * Typically same as completed bookings.
   */
  CANCELLED_BOOKING_RETENTION_DAYS: parseInt(
    process.env.CANCELLED_BOOKING_RETENTION_DAYS || '90'
  ),

  /**
   * Days to keep archived bookings before permanent deletion.
   * Set to 730 (2 years) for legal/audit compliance.
   */
  ARCHIVE_RETENTION_DAYS: parseInt(
    process.env.ARCHIVE_RETENTION_DAYS || '730'
  ),

  /**
   * Hours to keep cached calendar events before refresh.
   * Short TTL ensures freshness while reducing API calls.
   */
  CALENDAR_CACHE_TTL_HOURS: parseInt(
    process.env.CALENDAR_CACHE_TTL_HOURS || '24'
  ),

  /**
   * Minutes to keep computed availability slots cached.
   * Shorter than calendar cache since bookings change more frequently.
   */
  AVAILABILITY_CACHE_TTL_MINUTES: parseInt(
    process.env.AVAILABILITY_CACHE_TTL_MINUTES || '5'
  ),

  /**
   * Days to keep email notification logs.
   * Used for debugging delivery issues.
   */
  EMAIL_LOG_RETENTION_DAYS: parseInt(
    process.env.EMAIL_LOG_RETENTION_DAYS || '30'
  ),

  /**
   * Days to keep session data in Redis.
   */
  SESSION_RETENTION_DAYS: parseInt(
    process.env.SESSION_RETENTION_DAYS || '7'
  ),
} as const;

// ============================================================================
// ALERT THRESHOLDS
// ============================================================================

/**
 * Operational alert threshold configuration.
 * Used for monitoring and alerting on system health.
 */
export const ALERT_THRESHOLDS = {
  // Queue monitoring thresholds
  QUEUE: {
    /** Warning level for notification queue depth */
    NOTIFICATION_QUEUE_WARNING: parseInt(
      process.env.NOTIFICATION_QUEUE_WARNING || '100'
    ),
    /** Critical level for notification queue depth */
    NOTIFICATION_QUEUE_CRITICAL: parseInt(
      process.env.NOTIFICATION_QUEUE_CRITICAL || '500'
    ),
    /** Warning level for calendar sync queue depth */
    CALENDAR_SYNC_QUEUE_WARNING: parseInt(
      process.env.CALENDAR_SYNC_QUEUE_WARNING || '50'
    ),
    /** Critical level for calendar sync queue depth */
    CALENDAR_SYNC_QUEUE_CRITICAL: parseInt(
      process.env.CALENDAR_SYNC_QUEUE_CRITICAL || '200'
    ),
    /** Warning level for dead letter queue depth */
    DLQ_WARNING: parseInt(process.env.DLQ_WARNING || '10'),
    /** Critical level for dead letter queue depth */
    DLQ_CRITICAL: parseInt(process.env.DLQ_CRITICAL || '50'),
  },

  // Storage thresholds (in bytes)
  STORAGE: {
    /** Warning level for PostgreSQL total size (5 GB) */
    POSTGRES_WARNING_BYTES: parseInt(
      process.env.POSTGRES_WARNING_BYTES || String(5 * 1024 * 1024 * 1024)
    ),
    /** Critical level for PostgreSQL total size (10 GB) */
    POSTGRES_CRITICAL_BYTES: parseInt(
      process.env.POSTGRES_CRITICAL_BYTES || String(10 * 1024 * 1024 * 1024)
    ),
    /** Warning level for bookings table size (2 GB) */
    BOOKINGS_TABLE_WARNING_BYTES: parseInt(
      process.env.BOOKINGS_TABLE_WARNING_BYTES || String(2 * 1024 * 1024 * 1024)
    ),
    /** Critical level for bookings table size (5 GB) */
    BOOKINGS_TABLE_CRITICAL_BYTES: parseInt(
      process.env.BOOKINGS_TABLE_CRITICAL_BYTES || String(5 * 1024 * 1024 * 1024)
    ),
    /** Warning level for Redis/Valkey memory (256 MB) */
    REDIS_WARNING_BYTES: parseInt(
      process.env.REDIS_WARNING_BYTES || String(256 * 1024 * 1024)
    ),
    /** Critical level for Redis/Valkey memory (512 MB) */
    REDIS_CRITICAL_BYTES: parseInt(
      process.env.REDIS_CRITICAL_BYTES || String(512 * 1024 * 1024)
    ),
  },

  // Performance thresholds
  PERFORMANCE: {
    /** Target cache hit rate (percentage) */
    CACHE_HIT_RATE_TARGET: parseFloat(
      process.env.CACHE_HIT_RATE_TARGET || '0.80'
    ),
    /** Minimum acceptable cache hit rate (percentage) */
    CACHE_HIT_RATE_MINIMUM: parseFloat(
      process.env.CACHE_HIT_RATE_MINIMUM || '0.70'
    ),
    /** Booking creation p95 latency warning (ms) */
    BOOKING_LATENCY_P95_WARNING_MS: parseInt(
      process.env.BOOKING_LATENCY_P95_WARNING_MS || '500'
    ),
    /** Booking creation p95 latency critical (ms) */
    BOOKING_LATENCY_P95_CRITICAL_MS: parseInt(
      process.env.BOOKING_LATENCY_P95_CRITICAL_MS || '1000'
    ),
    /** Availability check latency target (ms) */
    AVAILABILITY_LATENCY_TARGET_MS: parseInt(
      process.env.AVAILABILITY_LATENCY_TARGET_MS || '200'
    ),
  },

  // Calendar sync thresholds
  CALENDAR_SYNC: {
    /** Maximum acceptable sync lag before warning (seconds) */
    LAG_WARNING_SECONDS: parseInt(
      process.env.CALENDAR_SYNC_LAG_WARNING || '1800'
    ), // 30 minutes
    /** Maximum acceptable sync lag before critical (seconds) */
    LAG_CRITICAL_SECONDS: parseInt(
      process.env.CALENDAR_SYNC_LAG_CRITICAL || '3600'
    ), // 1 hour
    /** Calendar sync interval (minutes) */
    SYNC_INTERVAL_MINUTES: parseInt(
      process.env.CALENDAR_SYNC_INTERVAL || '10'
    ),
  },

  // Database connection pool thresholds
  DATABASE: {
    /** Maximum number of connections in the pool */
    MAX_CONNECTIONS: parseInt(process.env.DB_MAX_CONNECTIONS || '20'),
    /** Warning level for idle connections */
    IDLE_CONNECTIONS_WARNING: parseInt(
      process.env.DB_IDLE_CONNECTIONS_WARNING || '15'
    ),
    /** Connection timeout (ms) */
    CONNECTION_TIMEOUT_MS: parseInt(
      process.env.DB_CONNECTION_TIMEOUT_MS || '2000'
    ),
  },
} as const;

// ============================================================================
// IDEMPOTENCY CONFIGURATION
// ============================================================================

/**
 * Configuration for idempotent request handling.
 * Prevents duplicate bookings from retry attempts.
 */
export const IDEMPOTENCY_CONFIG = {
  /**
   * TTL for idempotency keys in seconds.
   * Keys are stored in Redis to detect duplicate requests.
   */
  KEY_TTL_SECONDS: parseInt(process.env.IDEMPOTENCY_KEY_TTL || '3600'),

  /**
   * Prefix for idempotency keys in Redis.
   */
  KEY_PREFIX: 'calendly:idempotency:',

  /**
   * Header name for client-provided idempotency keys.
   */
  HEADER_NAME: 'X-Idempotency-Key',
} as const;

// ============================================================================
// APPLICATION SETTINGS
// ============================================================================

/**
 * General application configuration.
 */
export const APP_CONFIG = {
  PORT: parseInt(process.env.PORT || '3000'),
  NODE_ENV: process.env.NODE_ENV || 'development',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  SESSION_SECRET: process.env.SESSION_SECRET || 'calendly-secret-key-change-in-production',

  // Rate limiting
  RATE_LIMIT: {
    WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
    MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  },
} as const;

// ============================================================================
// DATABASE SETTINGS
// ============================================================================

/**
 * Database connection configuration.
 */
export const DB_CONFIG = {
  HOST: process.env.DB_HOST || 'localhost',
  PORT: parseInt(process.env.DB_PORT || '5432'),
  NAME: process.env.DB_NAME || 'calendly',
  USER: process.env.DB_USER || 'calendly',
  PASSWORD: process.env.DB_PASSWORD || 'calendly_password',
  MAX_CONNECTIONS: ALERT_THRESHOLDS.DATABASE.MAX_CONNECTIONS,
  IDLE_TIMEOUT_MS: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000'),
  CONNECTION_TIMEOUT_MS: ALERT_THRESHOLDS.DATABASE.CONNECTION_TIMEOUT_MS,
} as const;

/**
 * Redis/Valkey connection configuration.
 */
export const REDIS_CONFIG = {
  HOST: process.env.REDIS_HOST || 'localhost',
  PORT: parseInt(process.env.REDIS_PORT || '6379'),
  MAX_RETRIES: parseInt(process.env.REDIS_MAX_RETRIES || '3'),
} as const;

export default {
  RETENTION_CONFIG,
  ALERT_THRESHOLDS,
  IDEMPOTENCY_CONFIG,
  APP_CONFIG,
  DB_CONFIG,
  REDIS_CONFIG,
};
