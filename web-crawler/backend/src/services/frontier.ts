/**
 * @fileoverview URL Frontier Service for the distributed web crawler.
 *
 * The URL frontier is the heart of any web crawler - it manages the queue of URLs
 * to be crawled with priority-based scheduling. This implementation uses a hybrid
 * approach with PostgreSQL for durability and Redis for fast access patterns.
 *
 * Key responsibilities:
 * - Adding new URLs with deduplication (via Redis visited set)
 * - Priority-based URL scheduling (high/medium/low queues)
 * - Per-domain rate limiting (via Redis distributed locks)
 * - Status tracking (pending, in_progress, completed, failed)
 * - Recovery of stale in-progress URLs after worker crashes
 *
 * @module services/frontier
 */

import { pool } from '../models/database.js';
import { redis, REDIS_KEYS } from '../models/redis.js';
import {
  normalizeUrl,
  hashUrl,
  extractDomain,
  calculateDepth,
  calculatePriority,
  shouldCrawl,
} from '../utils/url.js';
import { config } from '../config.js';

/**
 * Represents a URL entry in the frontier queue.
 */
export interface FrontierUrl {
  /** Unique database ID */
  id: number;
  /** The normalized URL string */
  url: string;
  /** SHA-256 hash of the normalized URL for fast lookup */
  urlHash: string;
  /** Domain hostname extracted from the URL */
  domain: string;
  /** Priority level: 3 (high), 2 (medium), 1 (low) */
  priority: number;
  /** Depth from seed URL (0 = seed, 1 = one hop, etc.) */
  depth: number;
  /** Current status: pending, in_progress, completed, failed */
  status: string;
  /** When this URL was scheduled for crawling */
  scheduledAt: Date;
}

/**
 * Options for adding URLs to the frontier.
 */
export interface AddUrlOptions {
  /** Override the calculated priority (1-3) */
  priority?: number;
  /** Override the calculated depth */
  depth?: number;
  /** URL of the page where this link was found */
  parentUrl?: string;
}

/**
 * URL Frontier Service - manages the queue of URLs to be crawled.
 *
 * This service provides the core scheduling logic for the distributed crawler.
 * It ensures URLs are crawled in priority order while respecting rate limits
 * and avoiding duplicate work.
 *
 * @example
 * ```typescript
 * import { frontierService } from './services/frontier';
 *
 * // Add seed URLs with high priority
 * await frontierService.addUrls(['https://example.com'], { priority: 3, depth: 0 });
 *
 * // Get next URL to crawl
 * const url = await frontierService.getNextUrl('worker-1');
 * if (url) {
 *   // Crawl the URL...
 *   await frontierService.markCompleted(url.urlHash);
 * }
 * ```
 */
export class FrontierService {
  /**
   * Adds a single URL to the frontier if not already visited or queued.
   *
   * This method performs several checks before adding:
   * 1. Normalizes the URL for consistent deduplication
   * 2. Checks if URL should be crawled (HTTP/HTTPS, not a binary file)
   * 3. Checks Redis visited set for duplicates (O(1) lookup)
   * 4. Inserts into PostgreSQL with ON CONFLICT DO NOTHING
   * 5. Adds to Redis priority queue for fast retrieval
   *
   * @param url - The URL to add to the frontier
   * @param options - Optional priority, depth, and parent URL
   * @returns true if URL was added, false if skipped (duplicate or filtered)
   *
   * @example
   * ```typescript
   * const added = await frontierService.addUrl('https://example.com/page', {
   *   priority: 2,
   *   depth: 1,
   * });
   * console.log(added ? 'URL queued' : 'URL skipped');
   * ```
   */
  async addUrl(url: string, options: AddUrlOptions = {}): Promise<boolean> {
    const normalized = normalizeUrl(url);
    const urlHash = hashUrl(normalized);

    // Check if URL should be crawled
    if (!shouldCrawl(normalized)) {
      return false;
    }

    // Check if already visited (using Redis set for fast lookup)
    const isVisited = await redis.sismember(REDIS_KEYS.VISITED_URLS, urlHash);
    if (isVisited) {
      await redis.incr(REDIS_KEYS.STATS_DUPLICATES_SKIPPED);
      return false;
    }

    const domain = extractDomain(normalized);
    const depth = options.depth ?? calculateDepth(normalized);
    const isHomepage = depth === 0;
    const priority = options.priority ?? calculatePriority(normalized, depth, isHomepage);

    // Add to database frontier
    try {
      await pool.query(
        `INSERT INTO url_frontier (url, url_hash, domain, priority, depth, status, scheduled_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
         ON CONFLICT (url_hash) DO NOTHING`,
        [normalized, urlHash, domain, priority, depth]
      );

      // Also add to Redis priority queue for fast access
      const queueKey =
        priority >= 3
          ? REDIS_KEYS.PRIORITY_QUEUE_HIGH
          : priority >= 2
            ? REDIS_KEYS.PRIORITY_QUEUE_MEDIUM
            : REDIS_KEYS.PRIORITY_QUEUE_LOW;

      await redis.zadd(queueKey, Date.now(), urlHash);

      // Increment discovery stats
      await redis.incr(REDIS_KEYS.STATS_LINKS_DISCOVERED);

      return true;
    } catch (error) {
      console.error('Error adding URL to frontier:', error);
      return false;
    }
  }

  /**
   * Adds multiple URLs to the frontier in batch.
   *
   * Processes URLs sequentially to ensure proper deduplication.
   * For better performance with large batches, consider parallel processing
   * with a controlled concurrency limit.
   *
   * @param urls - Array of URLs to add
   * @param options - Options applied to all URLs
   * @returns Number of URLs successfully added (excluding duplicates)
   *
   * @example
   * ```typescript
   * const extractedLinks = ['https://example.com/a', 'https://example.com/b'];
   * const added = await frontierService.addUrls(extractedLinks, { depth: 2 });
   * console.log(`Added ${added} of ${extractedLinks.length} links`);
   * ```
   */
  async addUrls(urls: string[], options: AddUrlOptions = {}): Promise<number> {
    let added = 0;
    for (const url of urls) {
      const result = await this.addUrl(url, options);
      if (result) added++;
    }
    return added;
  }

  /**
   * Gets the next URL to crawl for a worker.
   *
   * This method implements the core scheduling logic:
   * 1. Checks priority queues in order (high -> medium -> low)
   * 2. For each URL, attempts to acquire a domain lock for rate limiting
   * 3. Marks the URL as in_progress and removes from Redis queue
   * 4. Returns the URL if lock acquired, continues to next if not
   *
   * The domain lock ensures only one worker crawls a domain at a time,
   * respecting the crawl delay from robots.txt or the default delay.
   *
   * @param workerId - Unique identifier of the requesting worker
   * @returns The next URL to crawl, or null if no URLs available
   *
   * @example
   * ```typescript
   * const frontierUrl = await frontierService.getNextUrl('worker-1');
   * if (frontierUrl) {
   *   console.log(`Crawling: ${frontierUrl.url} (priority: ${frontierUrl.priority})`);
   * } else {
   *   console.log('No URLs available');
   * }
   * ```
   */
  async getNextUrl(workerId: string): Promise<FrontierUrl | null> {
    // Try to get from high priority first, then medium, then low
    const queues = [
      REDIS_KEYS.PRIORITY_QUEUE_HIGH,
      REDIS_KEYS.PRIORITY_QUEUE_MEDIUM,
      REDIS_KEYS.PRIORITY_QUEUE_LOW,
    ];

    for (const queueKey of queues) {
      // Get oldest entries from queue
      const urlHashes = await redis.zrange(queueKey, 0, 100);

      for (const urlHash of urlHashes) {
        // Get URL from database
        const result = await pool.query(
          `SELECT id, url, url_hash, domain, priority, depth, status, scheduled_at
           FROM url_frontier
           WHERE url_hash = $1 AND status = 'pending'`,
          [urlHash]
        );

        if (result.rows.length === 0) {
          // URL not in frontier or already processed, remove from Redis queue
          await redis.zrem(queueKey, urlHash);
          continue;
        }

        const row = result.rows[0];
        const domain = row.domain;

        // Check if we can crawl this domain (rate limiting)
        const canCrawl = await this.acquireDomainLock(domain, workerId);
        if (!canCrawl) {
          continue;
        }

        // Mark as in-progress
        await pool.query(
          `UPDATE url_frontier SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );

        // Remove from Redis queue
        await redis.zrem(queueKey, urlHash);

        return {
          id: row.id,
          url: row.url,
          urlHash: row.url_hash,
          domain: row.domain,
          priority: row.priority,
          depth: row.depth,
          status: 'in_progress',
          scheduledAt: row.scheduled_at,
        };
      }
    }

    return null;
  }

  /**
   * Acquires a distributed lock for a domain to enforce rate limiting.
   *
   * Uses Redis SET with NX (only if not exists) and EX (expiry) to create
   * an atomic, self-expiring lock. This ensures:
   * - Only one worker can crawl a domain at any time
   * - Lock auto-releases after the crawl delay period
   * - No deadlocks even if worker crashes
   *
   * @param domain - The domain to acquire lock for
   * @param workerId - ID of the worker requesting the lock
   * @returns true if lock acquired, false if domain is locked by another worker
   */
  async acquireDomainLock(domain: string, workerId: string): Promise<boolean> {
    const lockKey = REDIS_KEYS.DOMAIN_LOCK(domain);
    const delayKey = REDIS_KEYS.DOMAIN_DELAY(domain);

    // Get domain-specific delay (from robots.txt crawl-delay or default)
    const delayStr = await redis.get(delayKey);
    const delayMs = delayStr ? parseFloat(delayStr) * 1000 : config.crawler.defaultDelay;
    const delaySeconds = Math.ceil(delayMs / 1000);

    // Try to acquire lock with NX (only if not exists) and EX (expiry)
    const result = await redis.set(lockKey, workerId, 'NX', 'EX', delaySeconds);

    return result === 'OK';
  }

  /**
   * Marks a URL as successfully completed.
   *
   * Updates the frontier status to 'completed' and adds the URL hash
   * to the visited set to prevent re-crawling.
   *
   * @param urlHash - SHA-256 hash of the URL to mark complete
   */
  async markCompleted(urlHash: string): Promise<void> {
    await pool.query(
      `UPDATE url_frontier SET status = 'completed', updated_at = NOW() WHERE url_hash = $1`,
      [urlHash]
    );

    // Add to visited set
    await redis.sadd(REDIS_KEYS.VISITED_URLS, urlHash);
  }

  /**
   * Marks a URL as failed.
   *
   * Updates the frontier status to 'failed' and adds to visited set
   * to prevent immediate retry. Future enhancement: implement retry logic
   * with exponential backoff.
   *
   * @param urlHash - SHA-256 hash of the URL that failed
   * @param error - Optional error message for debugging
   */
  async markFailed(urlHash: string, error?: string): Promise<void> {
    await pool.query(
      `UPDATE url_frontier SET status = 'failed', updated_at = NOW() WHERE url_hash = $1`,
      [urlHash]
    );

    // Still add to visited set to prevent retrying immediately
    await redis.sadd(REDIS_KEYS.VISITED_URLS, urlHash);
  }

  /**
   * Gets aggregated statistics about the frontier.
   *
   * Queries the database to count URLs by status and total unique domains.
   * Used by the dashboard to display crawler progress.
   *
   * @returns Object containing counts for each status and total domains
   */
  async getStats(): Promise<{
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    totalDomains: number;
  }> {
    const result = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM url_frontier
      GROUP BY status
    `);

    const stats = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
    for (const row of result.rows) {
      switch (row.status) {
        case 'pending':
          stats.pending = parseInt(row.count);
          break;
        case 'in_progress':
          stats.inProgress = parseInt(row.count);
          break;
        case 'completed':
          stats.completed = parseInt(row.count);
          break;
        case 'failed':
          stats.failed = parseInt(row.count);
          break;
      }
    }

    const domainResult = await pool.query(
      'SELECT COUNT(DISTINCT domain) as count FROM url_frontier'
    );
    const totalDomains = parseInt(domainResult.rows[0].count);

    return { ...stats, totalDomains };
  }

  /**
   * Gets recently updated URLs from the frontier.
   *
   * Useful for the dashboard to show current crawl activity.
   * Can be filtered by status to show only pending, in_progress, etc.
   *
   * @param limit - Maximum number of URLs to return (default: 50)
   * @param status - Optional status filter
   * @returns Array of recent frontier URLs sorted by update time
   */
  async getRecentUrls(
    limit: number = 50,
    status?: string
  ): Promise<FrontierUrl[]> {
    let query = `
      SELECT id, url, url_hash, domain, priority, depth, status, scheduled_at
      FROM url_frontier
    `;
    const params: (string | number)[] = [];

    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }

    query += ' ORDER BY updated_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await pool.query(query, params);

    return result.rows.map((row) => ({
      id: row.id,
      url: row.url,
      urlHash: row.url_hash,
      domain: row.domain,
      priority: row.priority,
      depth: row.depth,
      status: row.status,
      scheduledAt: row.scheduled_at,
    }));
  }

  /**
   * Recovers stale in-progress URLs after worker crashes.
   *
   * When a worker crashes, URLs it was processing remain in 'in_progress'
   * state forever. This method resets them to 'pending' so they can be
   * picked up by other workers.
   *
   * Should be called periodically by a cleanup job or on server startup.
   *
   * @param olderThanMinutes - Reset URLs that have been in_progress longer than this
   * @returns Number of URLs recovered
   *
   * @example
   * ```typescript
   * // Recover URLs stuck for more than 10 minutes
   * const recovered = await frontierService.recoverStaleUrls(10);
   * console.log(`Recovered ${recovered} stale URLs`);
   * ```
   */
  async recoverStaleUrls(olderThanMinutes: number = 10): Promise<number> {
    const result = await pool.query(
      `UPDATE url_frontier
       SET status = 'pending', updated_at = NOW()
       WHERE status = 'in_progress'
       AND updated_at < NOW() - INTERVAL '1 minute' * $1`,
      [olderThanMinutes]
    );

    return result.rowCount ?? 0;
  }
}

/**
 * Singleton instance of the FrontierService.
 * Use this export for all frontier operations to ensure consistent state.
 */
export const frontierService = new FrontierService();
