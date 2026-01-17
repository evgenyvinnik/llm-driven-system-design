/**
 * @fileoverview Redis connection and key definitions for the web crawler.
 *
 * Redis serves multiple critical functions in this distributed crawler:
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
 *
 * @module models/redis
 */

import Redis from 'ioredis';
import { config } from '../config.js';

/**
 * Redis client instance configured for the web crawler.
 *
 * Connection settings:
 * - maxRetriesPerRequest: 3 - Retry failed operations up to 3 times
 * - retryDelayOnFailover: 100ms - Wait briefly before retry on failover
 *
 * The client automatically reconnects on connection loss and queues
 * commands during disconnection for replay when reconnected.
 *
 * @example
 * ```typescript
 * import { redis } from './models/redis';
 *
 * // Check if URL was visited
 * const visited = await redis.sismember(REDIS_KEYS.VISITED_URLS, urlHash);
 *
 * // Increment page counter
 * await redis.incr(REDIS_KEYS.STATS_PAGES_CRAWLED);
 * ```
 */
export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

/**
 * Error handler for Redis connection issues.
 * Logs errors but does not crash the process - Redis client will attempt reconnection.
 */
redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

/**
 * Connection success handler for logging.
 */
redis.on('connect', () => {
  console.log('Connected to Redis');
});

/**
 * Redis key definitions for all crawler data structures.
 *
 * Keys are namespaced under "crawler:" to avoid conflicts with other
 * applications sharing the same Redis instance.
 *
 * Key patterns:
 * - Static keys: Direct string values for global data
 * - Dynamic keys: Functions returning keys for per-entity data (domain, worker)
 *
 * @example
 * ```typescript
 * // Static key usage
 * await redis.incr(REDIS_KEYS.STATS_PAGES_CRAWLED);
 *
 * // Dynamic key usage
 * const lockKey = REDIS_KEYS.DOMAIN_LOCK('example.com');
 * await redis.set(lockKey, workerId, 'NX', 'EX', 5);
 * ```
 */
export const REDIS_KEYS = {
  /**
   * Set containing SHA-256 hashes of all visited URLs.
   * Used for O(1) deduplication before adding URLs to the frontier.
   * At 10 billion URLs with 64-byte hashes = ~640GB RAM.
   */
  VISITED_URLS: 'crawler:visited_urls',

  /**
   * Stores the Unix timestamp of last access to a domain.
   * Used for rate limiting calculations.
   * @param domain - The domain hostname (e.g., 'example.com')
   * @returns Redis key string
   */
  DOMAIN_LAST_ACCESS: (domain: string) => `crawler:domain:${domain}:last_access`,

  /**
   * Caches robots.txt content for a domain.
   * TTL-based expiration ensures periodic refresh of robot rules.
   * @param domain - The domain hostname
   * @returns Redis key string
   */
  DOMAIN_ROBOTS: (domain: string) => `crawler:domain:${domain}:robots`,

  /**
   * Stores crawl delay (in seconds) for a domain.
   * Extracted from robots.txt Crawl-delay directive or uses default.
   * @param domain - The domain hostname
   * @returns Redis key string
   */
  DOMAIN_DELAY: (domain: string) => `crawler:domain:${domain}:delay`,

  /**
   * Distributed lock for per-domain rate limiting.
   * Workers use SET NX EX to acquire exclusive crawl rights for a domain.
   * Lock automatically expires after the crawl delay period.
   * @param domain - The domain hostname
   * @returns Redis key string
   */
  DOMAIN_LOCK: (domain: string) => `crawler:domain:${domain}:lock`,

  /**
   * Worker heartbeat timestamp for health monitoring.
   * Workers update this key every 5 seconds to indicate they're alive.
   * @param workerId - The unique worker identifier
   * @returns Redis key string
   */
  WORKER_HEARTBEAT: (workerId: string) => `crawler:worker:${workerId}:heartbeat`,

  /**
   * Set containing IDs of all active workers.
   * Dashboard uses this to display worker count and status.
   */
  ACTIVE_WORKERS: 'crawler:active_workers',

  /**
   * Counter: Total number of pages successfully crawled across all workers.
   */
  STATS_PAGES_CRAWLED: 'crawler:stats:pages_crawled',

  /**
   * Counter: Total number of pages that failed to crawl.
   */
  STATS_PAGES_FAILED: 'crawler:stats:pages_failed',

  /**
   * Counter: Total bytes of content downloaded across all workers.
   */
  STATS_BYTES_DOWNLOADED: 'crawler:stats:bytes_downloaded',

  /**
   * Counter: Total number of new URLs discovered from crawled pages.
   */
  STATS_LINKS_DISCOVERED: 'crawler:stats:links_discovered',

  /**
   * Counter: Number of duplicate URLs skipped (already in visited set).
   */
  STATS_DUPLICATES_SKIPPED: 'crawler:stats:duplicates_skipped',

  /**
   * Sorted set for high-priority URLs (priority 3).
   * Score is timestamp for FIFO ordering within priority level.
   */
  PRIORITY_QUEUE_HIGH: 'crawler:queue:high',

  /**
   * Sorted set for medium-priority URLs (priority 2).
   */
  PRIORITY_QUEUE_MEDIUM: 'crawler:queue:medium',

  /**
   * Sorted set for low-priority URLs (priority 1).
   */
  PRIORITY_QUEUE_LOW: 'crawler:queue:low',
};

/**
 * Closes the Redis connection gracefully.
 *
 * Should be called during application shutdown to:
 * 1. Complete any pending operations
 * 2. Release the connection to Redis server
 * 3. Allow the Node.js process to exit cleanly
 *
 * @returns Promise that resolves when connection is closed
 *
 * @example
 * ```typescript
 * import { closeRedis } from './models/redis';
 *
 * process.on('SIGTERM', async () => {
 *   await closeRedis();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeRedis() {
  await redis.quit();
}
