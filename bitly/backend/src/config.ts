/**
 * PostgreSQL database connection configuration.
 * Provides connection parameters for the main data store where URLs, users,
 * sessions, and click events are persisted.
 */
export const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'bitly',
  user: process.env.DB_USER || 'bitly',
  password: process.env.DB_PASSWORD || 'bitly_password',
};

/**
 * Redis/Valkey cache connection configuration.
 * Used for URL lookup caching and session storage to reduce database load.
 */
export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

/**
 * Express server configuration.
 * Defines the HTTP server settings including port, host, and CORS origin
 * for frontend communication.
 */
export const SERVER_CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
};

/**
 * Reads a positive integer from the environment, falling back to a default.
 * @param name - Environment variable name
 * @param fallback - Value used when the variable is unset or not a positive integer
 */
export function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * URL shortening service configuration.
 * Controls short code generation, key pool management, and URL validation rules.
 */
export const URL_CONFIG = {
  shortCodeLength: 7,
  keyPoolBatchSize: 100,
  keyPoolMinThreshold: 50,
  /**
   * How long a leased batch belongs to the instance that claimed it. After this the
   * reaper may hand unused keys to another instance.
   */
  keyLeaseTtlMs: envInt('KEY_LEASE_TTL_MS', 60 * 60 * 1000), // 60 minutes
  /**
   * Local keys are discarded this long *before* the lease expires, so a slow or paused
   * process never hands out a key the reaper may already have reclaimed.
   */
  keyLeaseSafetyMarginMs: envInt('KEY_LEASE_SAFETY_MARGIN_MS', 10 * 60 * 1000), // 10 minutes
  /** How often each API instance runs the stale-lease reaper. */
  keyReclaimIntervalMs: envInt('KEY_RECLAIM_INTERVAL_MS', 5 * 60 * 1000), // 5 minutes
  /** Attempts for a generated code before giving up on unique-violation collisions. */
  maxCreateAttempts: 3,
  /** Custom codes must fit urls.short_code VARCHAR(10). */
  customCodeMinLength: 4,
  customCodeMaxLength: 10,
  /** Upper bound for expires_in so the computed timestamp stays sane (10 years). */
  maxExpiresInSeconds: 10 * 365 * 24 * 60 * 60,
  defaultExpirationDays: 365,
  maxUrlLength: 2048,
  /**
   * Codes that would shadow a root-level route. Express matches routes
   * case-insensitively, so the check lowercases the candidate.
   */
  reservedWords: [
    'admin', 'api', 'login', 'signup', 'logout', 'health', 'status',
    'metrics', 'ready', 'dashboard',
  ],
};

if (URL_CONFIG.keyLeaseSafetyMarginMs >= URL_CONFIG.keyLeaseTtlMs) {
  throw new Error('KEY_LEASE_SAFETY_MARGIN_MS must be smaller than KEY_LEASE_TTL_MS');
}

/**
 * Cache TTL configuration for different data types.
 * Balances freshness vs performance for URL lookups and sessions.
 */
export const CACHE_CONFIG = {
  urlTTL: 86400, // 24 hours in seconds (upper bound; expiring links get less)
  urlNegativeTTL: 60, // seconds a "no such code" answer is remembered
  /**
   * Seconds after an invalidation during which lookups may not refill the cache.
   * Must exceed the slowest lookup (DB breaker timeout is 5s) so a read that started
   * before the write cannot put the old row back.
   */
  urlInvalidationGuardTTL: 10,
  sessionTTL: 86400 * 7, // 7 days in seconds (upper bound; never beyond session expiry)
};

/**
 * Idempotency-Key handling for URL creation.
 */
export const IDEMPOTENCY_CONFIG = {
  responseTTL: 86400, // completed responses are replayable for 24 hours
  processingTTL: 60, // claim held while the handler runs; frees the key if a process dies
  retryAfterSeconds: 1, // Retry-After sent with 409 while the original is in flight
};

/**
 * Rate limiting configuration for API endpoints.
 * Protects against abuse and ensures fair usage across users.
 */
export const RATE_LIMIT_CONFIG = {
  createUrl: {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 100, // 100 requests per hour
  },
  redirect: {
    windowMs: 60 * 1000, // 1 minute
    max: 1000, // 1000 requests per minute
  },
  general: {
    windowMs: 60 * 1000, // 1 minute
    max: 200, // 200 requests per minute
  },
};

/**
 * Authentication and session configuration.
 * Defines password hashing strength, session duration, and cookie settings.
 */
export const AUTH_CONFIG = {
  bcryptRounds: 10,
  sessionDuration: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  cookieName: 'bitly_session',
};

/**
 * Unique identifier for this server instance.
 * Used for key pool allocation to prevent multiple servers from using the same keys.
 */
export const SERVER_ID = process.env.SERVER_ID || `server-${process.pid}`;

/**
 * Upper bound for graceful shutdown before the process force-exits.
 */
export const SHUTDOWN_TIMEOUT_MS = envInt('SHUTDOWN_TIMEOUT_MS', 10000);
