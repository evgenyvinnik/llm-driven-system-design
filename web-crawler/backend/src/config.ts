/**
 * @fileoverview Configuration module for the distributed web crawler backend.
 *
 * This module centralizes all configuration values used throughout the crawler system.
 * Values are loaded from environment variables with sensible defaults for local development.
 * This approach allows the same codebase to run in different environments (dev, staging, prod)
 * without code changes - only environment variable adjustments are needed.
 *
 * @module config
 */

/**
 * Main configuration object for the web crawler.
 *
 * All configuration is centralized here to:
 * 1. Provide a single source of truth for all settings
 * 2. Enable environment-based configuration via env vars
 * 3. Supply sensible defaults for local development
 * 4. Make configuration changes traceable and testable
 *
 * @example
 * ```typescript
 * import { config } from './config';
 *
 * // Access server port
 * const port = config.port;
 *
 * // Access PostgreSQL connection settings
 * const { host, port, database } = config.postgres;
 *
 * // Access crawler-specific settings
 * const delay = config.crawler.defaultDelay;
 * ```
 */
export const config = {
  /**
   * Port number for the Express HTTP server.
   * Used by both the API server and health check endpoints.
   * @default 3001
   */
  port: parseInt(process.env.PORT || '3001', 10),

  /**
   * Current Node.js environment.
   * Affects logging verbosity, error detail exposure, and other runtime behaviors.
   * @default 'development'
   */
  nodeEnv: process.env.NODE_ENV || 'development',

  /**
   * PostgreSQL database connection configuration.
   *
   * PostgreSQL is the primary persistent store for:
   * - URL frontier (URLs to crawl with their priorities and states)
   * - Crawled pages (content, metadata, extracted links)
   * - Domain information (robots.txt cache, crawl delays)
   * - Seed URLs for initiating crawls
   * - Crawl statistics and history
   *
   * Using PostgreSQL provides ACID guarantees for URL state transitions,
   * efficient priority-based queries via indexes, and durability for long-running crawls.
   */
  postgres: {
    /** @default 'localhost' */
    host: process.env.POSTGRES_HOST || 'localhost',
    /** @default 5432 */
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    /** @default 'webcrawler' */
    database: process.env.POSTGRES_DB || 'webcrawler',
    /** @default 'postgres' */
    user: process.env.POSTGRES_USER || 'postgres',
    /** @default 'postgres' */
    password: process.env.POSTGRES_PASSWORD || 'postgres',
  },

  /**
   * Redis connection configuration.
   *
   * Redis serves multiple critical functions in the crawler:
   * - URL deduplication via visited URL sets (O(1) lookup)
   * - Per-domain rate limiting using distributed locks with TTL
   * - Worker heartbeat tracking for health monitoring
   * - Real-time statistics counters (pages crawled, errors, etc.)
   * - Priority queues for fast URL retrieval by priority level
   *
   * Redis was chosen over alternatives because it provides:
   * - Sub-millisecond operations for hot path (URL checks, locks)
   * - Atomic operations (SET NX EX) for safe distributed locking
   * - Built-in TTL for automatic lock expiration
   */
  redis: {
    /** @default 'localhost' */
    host: process.env.REDIS_HOST || 'localhost',
    /** @default 6379 */
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    /** Optional password for authenticated Redis instances */
    password: process.env.REDIS_PASSWORD || undefined,
  },

  /**
   * Crawler worker configuration.
   *
   * These settings control how individual crawler workers behave.
   * Workers are stateless processes that fetch URLs from the frontier,
   * download pages, extract links, and store results.
   */
  crawler: {
    /**
     * Unique identifier for this worker instance.
     * Used for distributed coordination, heartbeat tracking,
     * and debugging which worker processed which URLs.
     * Each worker in a cluster should have a unique ID.
     * @default '1'
     */
    workerId: process.env.WORKER_ID || '1',

    /**
     * User-Agent string sent with HTTP requests.
     * Should identify the crawler and provide contact info.
     * Well-behaved crawlers include a URL where site owners
     * can learn more about the bot and request exclusion.
     * @default 'WebCrawlerBot/1.0 (+https://github.com/example/webcrawler)'
     */
    userAgent:
      process.env.CRAWLER_USER_AGENT ||
      'WebCrawlerBot/1.0 (+https://github.com/example/webcrawler)',

    /**
     * Minimum delay in milliseconds between requests to the same domain.
     * This implements "crawl politeness" - not overwhelming any single server.
     * Can be overridden by the Crawl-delay directive in robots.txt.
     * @default 1000 (1 second)
     */
    defaultDelay: parseInt(process.env.CRAWLER_DELAY || '1000', 10),

    /**
     * Maximum number of concurrent HTTP requests across all domains.
     * Limits overall crawler resource consumption and network bandwidth.
     * Higher values increase throughput but also memory and CPU usage.
     * @default 10
     */
    maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT || '10', 10),

    /**
     * Timeout in milliseconds for individual HTTP requests.
     * Prevents workers from hanging on slow or unresponsive servers.
     * After timeout, the URL is marked as failed and may be retried.
     * @default 30000 (30 seconds)
     */
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '30000', 10),

    /**
     * Maximum page size in bytes to download.
     * Protects against memory exhaustion from extremely large pages.
     * Pages exceeding this limit are truncated or skipped.
     * @default 10485760 (10MB)
     */
    maxPageSize: parseInt(process.env.MAX_PAGE_SIZE || '10485760', 10),

    /**
     * Time-to-live in seconds for cached robots.txt files.
     * robots.txt is cached at multiple levels (memory, Redis, PostgreSQL)
     * to minimize repeated fetches while respecting site policy updates.
     * @default 3600 (1 hour)
     */
    robotsTxtCacheTtl: parseInt(process.env.ROBOTS_CACHE_TTL || '3600', 10),
  },

  /**
   * Priority levels for URL scheduling.
   *
   * URLs are assigned priorities to control crawl order:
   * - High (3): Seed URLs, homepages, shallow pages - crawled first
   * - Medium (2): Content pages, blog posts, important internal links
   * - Low (1): Paginated content, archives, deep nested pages
   *
   * Higher priority URLs are dequeued first from the frontier.
   * This ensures the crawler focuses on important pages before
   * getting lost in infinite pagination or archive depths.
   */
  priorities: {
    /** Priority for seed URLs and high-value pages */
    high: 3,
    /** Priority for regular content pages */
    medium: 2,
    /** Priority for low-value or deep pages */
    low: 1,
  },
};
