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

export interface FrontierUrl {
  id: number;
  url: string;
  urlHash: string;
  domain: string;
  priority: number;
  depth: number;
  status: string;
  scheduledAt: Date;
}

export interface AddUrlOptions {
  priority?: number;
  depth?: number;
  parentUrl?: string;
}

/**
 * URL Frontier Service
 * Manages the queue of URLs to be crawled with priority-based scheduling
 */
export class FrontierService {
  /**
   * Add a URL to the frontier (if not already visited/queued)
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
   * Add multiple URLs to the frontier in batch
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
   * Get next URL to crawl for a specific domain (respecting rate limits)
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
   * Acquire lock for a domain to enforce rate limiting
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
   * Mark a URL as completed
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
   * Mark a URL as failed
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
   * Get frontier statistics
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
   * Get recent frontier entries
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
   * Clear all stale in-progress URLs (for recovery after worker crash)
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

export const frontierService = new FrontierService();
