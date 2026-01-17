/**
 * @fileoverview Configuration for the rate limiter service.
 * Loads settings from environment variables with sensible defaults for local development.
 */

/**
 * Graceful degradation mode when Redis is unavailable.
 * - 'allow': Fail-open, allow all requests (recommended for rate limiting)
 * - 'deny': Fail-closed, deny all requests (use for strict security)
 */
export type DegradationMode = 'allow' | 'deny';

/**
 * Central configuration object for the rate limiter service.
 * All settings can be overridden via environment variables for production deployments.
 */
export const config = {
  /** Port the HTTP server listens on */
  port: parseInt(process.env.PORT || '3001', 10),

  /** Node environment */
  nodeEnv: process.env.NODE_ENV || 'development',

  /**
   * Redis connection settings.
   * Redis is used as the distributed store for all rate limiting state.
   */
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    /** Prefix for all rate limiting keys to avoid collisions */
    keyPrefix: 'ratelimit:',
    /** Connection timeout in milliseconds */
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT || '10000', 10),
    /** Command timeout in milliseconds */
    commandTimeout: parseInt(process.env.REDIS_COMMAND_TIMEOUT || '3000', 10),
    /** Maximum retries per request */
    maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES || '3', 10),
  },

  /**
   * PostgreSQL connection settings.
   * Used for storing rate limit rules and configuration (future feature).
   */
  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'ratelimiter',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
  },

  /**
   * Default rate limiting parameters.
   * Used when clients don't specify their own values.
   */
  defaults: {
    /** Default algorithm provides good balance of accuracy and memory */
    algorithm: 'sliding_window' as const,
    /** Default requests per window */
    limit: 100,
    /** Default window duration in seconds */
    windowSeconds: 60,
    /** Default maximum burst capacity for bucket algorithms */
    burstCapacity: 10,
    /** Default token bucket refill rate (tokens per second) */
    refillRate: 1,
    /** Default leaky bucket drain rate (requests per second) */
    leakRate: 1,
  },

  /**
   * TTL (Time-To-Live) configuration for rate limit data.
   * Proper TTL prevents unbounded memory growth in Redis.
   */
  ttl: {
    /**
     * TTL multiplier for window-based keys.
     * Keys expire at windowSeconds * multiplier to cover the full window + buffer.
     * Default: 2x window size ensures data persists through window transitions.
     */
    windowMultiplier: parseFloat(process.env.TTL_WINDOW_MULTIPLIER || '2'),

    /**
     * TTL for token/leaky bucket state in seconds.
     * Longer TTL preserves accumulated tokens for inactive users.
     * Default: 24 hours
     */
    bucketStateTtl: parseInt(process.env.TTL_BUCKET_STATE || '86400', 10),

    /**
     * TTL for metrics data in seconds.
     * Metrics are aggregated to PostgreSQL before expiry.
     * Default: 1 hour
     */
    metricsTtl: parseInt(process.env.TTL_METRICS || '3600', 10),

    /**
     * TTL for detailed latency data in seconds.
     * Shorter TTL for high-cardinality data.
     * Default: 15 minutes
     */
    latencyDetailsTtl: parseInt(process.env.TTL_LATENCY_DETAILS || '900', 10),
  },

  /**
   * Circuit breaker configuration for Redis operations.
   * Prevents cascading failures when Redis is unavailable.
   */
  circuitBreaker: {
    /** Time in ms before operation times out */
    timeout: parseInt(process.env.CB_TIMEOUT || '3000', 10),
    /** Error percentage to trigger open state (0-100) */
    errorThreshold: parseInt(process.env.CB_ERROR_THRESHOLD || '50', 10),
    /** Time in ms to wait before testing recovery */
    resetTimeout: parseInt(process.env.CB_RESET_TIMEOUT || '10000', 10),
    /** Minimum requests before circuit can open */
    volumeThreshold: parseInt(process.env.CB_VOLUME_THRESHOLD || '5', 10),
  },

  /**
   * Graceful degradation settings.
   * Defines behavior when Redis or other dependencies are unavailable.
   */
  degradation: {
    /**
     * Behavior when Redis is unavailable.
     * - 'allow': Fail-open - allow requests to pass (recommended)
     * - 'deny': Fail-closed - deny all requests
     *
     * Fail-open is recommended because rate limiting protects against
     * sustained abuse, not individual requests. Blocking all traffic
     * during a Redis outage would cause more harm than allowing
     * potentially abusive requests temporarily.
     */
    mode: (process.env.DEGRADATION_MODE || 'allow') as DegradationMode,

    /**
     * Default values to return in fallback mode.
     * These are returned when Redis is unavailable and degradation.mode is 'allow'.
     */
    fallbackResponse: {
      allowed: true,
      remaining: -1, // -1 indicates unknown/fallback
      limit: 0,
      resetTime: 0,
      isFallback: true,
    },

    /**
     * Log a warning every N fallback activations.
     * Prevents log flooding during extended outages.
     */
    logWarningInterval: parseInt(process.env.DEGRADATION_LOG_INTERVAL || '100', 10),
  },

  /**
   * CORS settings for the API.
   * In production, restrict to your frontend domain.
   */
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },

  /**
   * Health check configuration.
   */
  health: {
    /** Maximum acceptable Redis latency in ms for healthy status */
    maxRedisLatencyMs: parseInt(process.env.HEALTH_MAX_REDIS_LATENCY || '100', 10),
  },
};

/** Type representing the configuration object shape */
export type Config = typeof config;
