/**
 * @fileoverview Configuration for the rate limiter service.
 * Loads settings from environment variables with sensible defaults for local development.
 */

/**
 * Central configuration object for the rate limiter service.
 * All settings can be overridden via environment variables for production deployments.
 */
export const config = {
  /** Port the HTTP server listens on */
  port: parseInt(process.env.PORT || '3001', 10),

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
   * CORS settings for the API.
   * In production, restrict to your frontend domain.
   */
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
};

/** Type representing the configuration object shape */
export type Config = typeof config;
