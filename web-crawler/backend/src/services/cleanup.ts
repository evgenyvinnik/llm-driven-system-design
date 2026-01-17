/**
 * @fileoverview Cleanup job service for data lifecycle management.
 *
 * Implements configurable TTL-based cleanup of old crawl data to prevent
 * unbounded storage growth.
 *
 * WHY DATA LIFECYCLE POLICIES:
 * Web crawlers generate data continuously. Without cleanup:
 * 1. Database storage grows unbounded (GB/day at scale)
 * 2. Query performance degrades as tables grow
 * 3. Backup/restore times increase
 * 4. Storage costs escalate
 *
 * Different data types have different retention needs:
 * - Completed URLs: Short retention (crawled, job done)
 * - Failed URLs: Longer retention (for debugging patterns)
 * - Crawled pages: Medium retention (historical data)
 * - Active URLs: Never deleted (still in queue)
 *
 * @module services/cleanup
 */

import { pool } from '../models/database.js';
import { redis } from '../models/redis.js';
import { logger } from '../shared/logger.js';
import { cleanupRecordsCounter, lastCleanupTimestampGauge } from '../shared/metrics.js';

/**
 * Cleanup configuration for different data types.
 */
export interface CleanupConfig {
  /** TTL for completed URLs in the frontier (days) */
  completedUrlTtlDays: number;
  /** TTL for failed URLs in the frontier (days) */
  failedUrlTtlDays: number;
  /** TTL for crawled pages (days) */
  crawledPagesTtlDays: number;
  /** TTL for stats records (days) */
  statsTtlDays: number;
  /** Batch size for deletion to avoid long transactions */
  batchSize: number;
  /** Interval between cleanup runs (minutes) */
  intervalMinutes: number;
}

/**
 * Default cleanup configuration.
 * Tuned for local development - production would have longer retention.
 */
export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  completedUrlTtlDays: 7,    // Keep completed URLs for 1 week
  failedUrlTtlDays: 30,      // Keep failed URLs for 1 month (debugging)
  crawledPagesTtlDays: 90,   // Keep page metadata for 3 months
  statsTtlDays: 7,           // Keep detailed stats for 1 week
  batchSize: 1000,           // Delete 1000 records at a time
  intervalMinutes: 60,       // Run cleanup every hour
};

/**
 * Cleanup job result.
 */
export interface CleanupResult {
  completedUrlsDeleted: number;
  failedUrlsDeleted: number;
  crawledPagesDeleted: number;
  statsDeleted: number;
  durationMs: number;
}

/**
 * Cleanup service for managing data lifecycle.
 */
export class CleanupService {
  private config: CleanupConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(config: CleanupConfig = DEFAULT_CLEANUP_CONFIG) {
    this.config = config;
  }

  /**
   * Starts the periodic cleanup job.
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('Cleanup service already running');
      return;
    }

    logger.info(
      { config: this.config },
      'Starting cleanup service'
    );

    // Run immediately on start
    this.runCleanup().catch((err) => {
      logger.error({ err }, 'Initial cleanup failed');
    });

    // Schedule periodic runs
    this.intervalId = setInterval(
      () => {
        this.runCleanup().catch((err) => {
          logger.error({ err }, 'Scheduled cleanup failed');
        });
      },
      this.config.intervalMinutes * 60 * 1000
    );
  }

  /**
   * Stops the periodic cleanup job.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Cleanup service stopped');
    }
  }

  /**
   * Runs the cleanup job.
   * Can be called manually or by the scheduler.
   */
  async runCleanup(): Promise<CleanupResult> {
    if (this.isRunning) {
      logger.warn('Cleanup already in progress, skipping');
      return {
        completedUrlsDeleted: 0,
        failedUrlsDeleted: 0,
        crawledPagesDeleted: 0,
        statsDeleted: 0,
        durationMs: 0,
      };
    }

    this.isRunning = true;
    const startTime = Date.now();
    logger.info('Starting cleanup job');

    try {
      const results = await Promise.all([
        this.cleanupCompletedUrls(),
        this.cleanupFailedUrls(),
        this.cleanupCrawledPages(),
        this.cleanupStats(),
      ]);

      const result: CleanupResult = {
        completedUrlsDeleted: results[0],
        failedUrlsDeleted: results[1],
        crawledPagesDeleted: results[2],
        statsDeleted: results[3],
        durationMs: Date.now() - startTime,
      };

      // Update metrics
      lastCleanupTimestampGauge.set(Date.now() / 1000);

      logger.info(
        {
          ...result,
          durationSeconds: result.durationMs / 1000,
        },
        'Cleanup job completed'
      );

      return result;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Cleans up completed URLs from the frontier.
   */
  private async cleanupCompletedUrls(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.completedUrlTtlDays);

    let totalDeleted = 0;
    let deleted: number;

    do {
      const result = await pool.query(
        `DELETE FROM url_frontier
         WHERE status = 'completed'
         AND updated_at < $1
         AND id IN (
           SELECT id FROM url_frontier
           WHERE status = 'completed'
           AND updated_at < $1
           LIMIT $2
         )`,
        [cutoffDate, this.config.batchSize]
      );

      deleted = result.rowCount ?? 0;
      totalDeleted += deleted;

      if (deleted > 0) {
        logger.debug({ deleted, total: totalDeleted }, 'Deleted completed URLs batch');
      }
    } while (deleted === this.config.batchSize);

    if (totalDeleted > 0) {
      cleanupRecordsCounter.labels('url_frontier_completed').inc(totalDeleted);
      logger.info({ count: totalDeleted }, 'Cleaned up completed URLs');
    }

    return totalDeleted;
  }

  /**
   * Cleans up failed URLs from the frontier.
   */
  private async cleanupFailedUrls(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.failedUrlTtlDays);

    let totalDeleted = 0;
    let deleted: number;

    do {
      const result = await pool.query(
        `DELETE FROM url_frontier
         WHERE status = 'failed'
         AND updated_at < $1
         AND id IN (
           SELECT id FROM url_frontier
           WHERE status = 'failed'
           AND updated_at < $1
           LIMIT $2
         )`,
        [cutoffDate, this.config.batchSize]
      );

      deleted = result.rowCount ?? 0;
      totalDeleted += deleted;
    } while (deleted === this.config.batchSize);

    if (totalDeleted > 0) {
      cleanupRecordsCounter.labels('url_frontier_failed').inc(totalDeleted);
      logger.info({ count: totalDeleted }, 'Cleaned up failed URLs');
    }

    return totalDeleted;
  }

  /**
   * Cleans up old crawled pages.
   */
  private async cleanupCrawledPages(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.crawledPagesTtlDays);

    let totalDeleted = 0;
    let deleted: number;

    do {
      const result = await pool.query(
        `DELETE FROM crawled_pages
         WHERE crawled_at < $1
         AND id IN (
           SELECT id FROM crawled_pages
           WHERE crawled_at < $1
           LIMIT $2
         )`,
        [cutoffDate, this.config.batchSize]
      );

      deleted = result.rowCount ?? 0;
      totalDeleted += deleted;
    } while (deleted === this.config.batchSize);

    if (totalDeleted > 0) {
      cleanupRecordsCounter.labels('crawled_pages').inc(totalDeleted);
      logger.info({ count: totalDeleted }, 'Cleaned up old crawled pages');
    }

    return totalDeleted;
  }

  /**
   * Cleans up old stats records.
   */
  private async cleanupStats(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.statsTtlDays);

    const result = await pool.query(
      `DELETE FROM crawl_stats
       WHERE timestamp < $1`,
      [cutoffDate]
    );

    const deleted = result.rowCount ?? 0;

    if (deleted > 0) {
      cleanupRecordsCounter.labels('crawl_stats').inc(deleted);
      logger.info({ count: deleted }, 'Cleaned up old stats');
    }

    return deleted;
  }

  /**
   * Cleans up Redis keys that may have stale data.
   * This includes:
   * - Stale worker heartbeats
   * - Old circuit breaker states
   */
  async cleanupRedis(): Promise<number> {
    let cleaned = 0;

    // Clean up stale worker heartbeats (workers inactive for > 5 minutes)
    const activeWorkers = await redis.smembers('crawler:active_workers');
    const staleThreshold = Date.now() - 5 * 60 * 1000;

    for (const workerId of activeWorkers) {
      const heartbeat = await redis.get(`crawler:worker:${workerId}:heartbeat`);
      if (!heartbeat || parseInt(heartbeat, 10) < staleThreshold) {
        await redis.srem('crawler:active_workers', workerId);
        await redis.del(`crawler:worker:${workerId}:heartbeat`);
        cleaned++;
        logger.info({ workerId }, 'Cleaned up stale worker');
      }
    }

    // Circuit breaker states auto-expire via TTL, no cleanup needed

    if (cleaned > 0) {
      cleanupRecordsCounter.labels('redis_workers').inc(cleaned);
    }

    return cleaned;
  }

  /**
   * Gets storage statistics for monitoring.
   */
  async getStorageStats(): Promise<{
    urlFrontier: { pending: number; inProgress: number; completed: number; failed: number };
    crawledPages: number;
    domains: number;
    stats: number;
    redisMemory: string;
  }> {
    const [frontierStats, pagesCount, domainsCount, statsCount, redisInfo] =
      await Promise.all([
        pool.query(`
          SELECT status, COUNT(*) as count
          FROM url_frontier
          GROUP BY status
        `),
        pool.query('SELECT COUNT(*) as count FROM crawled_pages'),
        pool.query('SELECT COUNT(*) as count FROM domains'),
        pool.query('SELECT COUNT(*) as count FROM crawl_stats'),
        redis.info('memory'),
      ]);

    const frontier = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
    for (const row of frontierStats.rows) {
      switch (row.status) {
        case 'pending':
          frontier.pending = parseInt(row.count);
          break;
        case 'in_progress':
          frontier.inProgress = parseInt(row.count);
          break;
        case 'completed':
          frontier.completed = parseInt(row.count);
          break;
        case 'failed':
          frontier.failed = parseInt(row.count);
          break;
      }
    }

    // Extract used_memory_human from Redis INFO
    const memoryMatch = redisInfo.match(/used_memory_human:(\S+)/);
    const redisMemory = memoryMatch ? memoryMatch[1] : 'unknown';

    return {
      urlFrontier: frontier,
      crawledPages: parseInt(pagesCount.rows[0].count),
      domains: parseInt(domainsCount.rows[0].count),
      stats: parseInt(statsCount.rows[0].count),
      redisMemory,
    };
  }
}

/**
 * Singleton cleanup service instance.
 */
export const cleanupService = new CleanupService();
