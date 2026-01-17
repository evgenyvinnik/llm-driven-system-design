/**
 * Application configuration with article retention and other settings.
 * Centralizes configuration for easy management and environment overrides.
 * @module shared/config
 */

/**
 * Parse an integer from environment variable with default.
 */
function parseIntEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse a boolean from environment variable.
 */
function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Application configuration.
 * All values can be overridden via environment variables.
 */
export const config = {
  /**
   * Server configuration.
   */
  server: {
    /** HTTP port */
    port: parseIntEnv('PORT', 3000),
    /** Environment: 'development' | 'production' | 'test' */
    nodeEnv: process.env.NODE_ENV || 'development',
    /** Frontend URL for CORS */
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  },

  /**
   * Database configuration.
   */
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseIntEnv('DB_PORT', 5432),
    user: process.env.DB_USER || 'newsagg',
    password: process.env.DB_PASSWORD || 'newsagg_dev',
    name: process.env.DB_NAME || 'news_aggregator',
    /** Maximum connections in pool */
    maxConnections: parseIntEnv('DB_MAX_CONNECTIONS', 20),
    /** Idle timeout in milliseconds */
    idleTimeoutMs: parseIntEnv('DB_IDLE_TIMEOUT_MS', 30000),
    /** Connection timeout in milliseconds */
    connectionTimeoutMs: parseIntEnv('DB_CONNECTION_TIMEOUT_MS', 2000),
  },

  /**
   * Redis configuration.
   */
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseIntEnv('REDIS_PORT', 6379),
    password: process.env.REDIS_PASSWORD,
  },

  /**
   * Elasticsearch configuration.
   */
  elasticsearch: {
    url: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  },

  /**
   * Article retention configuration.
   * Controls how long articles are kept before cleanup.
   */
  retention: {
    /** Number of days to retain articles in the database (default: 90) */
    articleRetentionDays: parseIntEnv('ARTICLE_RETENTION_DAYS', 90),
    /** Number of days to retain articles in Elasticsearch (default: 90) */
    searchIndexRetentionDays: parseIntEnv('SEARCH_INDEX_RETENTION_DAYS', 90),
    /** Number of days to retain stories (default: 180) */
    storyRetentionDays: parseIntEnv('STORY_RETENTION_DAYS', 180),
    /** Number of days to retain user reading history (default: 365) */
    readingHistoryRetentionDays: parseIntEnv('READING_HISTORY_RETENTION_DAYS', 365),
    /** Enable automatic cleanup job (default: true in production) */
    enableAutoCleanup: parseBoolEnv('ENABLE_AUTO_CLEANUP', process.env.NODE_ENV === 'production'),
    /** Cleanup batch size (default: 1000) */
    cleanupBatchSize: parseIntEnv('CLEANUP_BATCH_SIZE', 1000),
  },

  /**
   * Crawler configuration.
   */
  crawler: {
    /** Default crawl interval in minutes */
    defaultCrawlIntervalMinutes: parseIntEnv('DEFAULT_CRAWL_INTERVAL_MINUTES', 15),
    /** Maximum concurrent crawl jobs */
    maxConcurrentCrawls: parseIntEnv('MAX_CONCURRENT_CRAWLS', 10),
    /** Request timeout in milliseconds */
    requestTimeoutMs: parseIntEnv('CRAWLER_REQUEST_TIMEOUT_MS', 30000),
    /** Minimum delay between requests to same domain */
    domainDelayMs: parseIntEnv('CRAWLER_DOMAIN_DELAY_MS', 1000),
    /** User agent for requests */
    userAgent: process.env.CRAWLER_USER_AGENT || 'NewsAggregator/1.0 (Learning Project)',
  },

  /**
   * Retry configuration.
   */
  retry: {
    /** Maximum retry attempts */
    maxRetries: parseIntEnv('RETRY_MAX_ATTEMPTS', 3),
    /** Initial delay in milliseconds */
    initialDelayMs: parseIntEnv('RETRY_INITIAL_DELAY_MS', 1000),
    /** Maximum delay in milliseconds */
    maxDelayMs: parseIntEnv('RETRY_MAX_DELAY_MS', 30000),
  },

  /**
   * Circuit breaker configuration.
   */
  circuitBreaker: {
    /** Request timeout in milliseconds */
    timeoutMs: parseIntEnv('CIRCUIT_BREAKER_TIMEOUT_MS', 10000),
    /** Error threshold percentage to trip breaker */
    errorThresholdPercentage: parseIntEnv('CIRCUIT_BREAKER_ERROR_THRESHOLD', 50),
    /** Time to wait before trying again (milliseconds) */
    resetTimeoutMs: parseIntEnv('CIRCUIT_BREAKER_RESET_TIMEOUT_MS', 30000),
    /** Minimum requests before circuit can trip */
    volumeThreshold: parseIntEnv('CIRCUIT_BREAKER_VOLUME_THRESHOLD', 5),
  },

  /**
   * Cache TTL configuration (in seconds).
   */
  cache: {
    /** Feed cache TTL */
    feedTtl: parseIntEnv('CACHE_FEED_TTL', 60),
    /** User preferences cache TTL */
    userPrefsTtl: parseIntEnv('CACHE_USER_PREFS_TTL', 300),
    /** Breaking news cache TTL */
    breakingTtl: parseIntEnv('CACHE_BREAKING_TTL', 30),
    /** Trending cache TTL */
    trendingTtl: parseIntEnv('CACHE_TRENDING_TTL', 60),
    /** Session TTL */
    sessionTtl: parseIntEnv('CACHE_SESSION_TTL', 86400),
  },

  /**
   * Logging configuration.
   */
  logging: {
    /** Log level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' */
    level: process.env.LOG_LEVEL || 'info',
    /** Pretty print logs in development */
    prettyPrint: parseBoolEnv('LOG_PRETTY_PRINT', process.env.NODE_ENV !== 'production'),
  },

  /**
   * Feature flags.
   */
  features: {
    /** Enable Prometheus metrics endpoint */
    enableMetrics: parseBoolEnv('ENABLE_METRICS', true),
    /** Enable request logging */
    enableRequestLogging: parseBoolEnv('ENABLE_REQUEST_LOGGING', true),
  },
} as const;

/**
 * Validate configuration and log warnings for missing optional values.
 */
export function validateConfig(): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // Check for production without proper settings
  if (config.server.nodeEnv === 'production') {
    if (!process.env.REDIS_PASSWORD) {
      warnings.push('REDIS_PASSWORD not set in production');
    }
    if (config.database.password === 'newsagg_dev') {
      warnings.push('Using default database password in production');
    }
  }

  // Check retention settings
  if (config.retention.articleRetentionDays < 7) {
    warnings.push('Article retention less than 7 days may cause data loss');
  }

  return { valid: true, warnings };
}

export default config;
