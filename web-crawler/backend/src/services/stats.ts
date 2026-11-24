/**
 * @fileoverview Statistics Service for crawler monitoring and reporting.
 *
 * This service aggregates and provides crawl statistics from multiple sources:
 * - Redis counters for real-time metrics (pages crawled, bytes downloaded)
 * - PostgreSQL for frontier status and historical data
 * - Worker heartbeats for monitoring worker health
 *
 * The statistics are consumed by the dashboard to display:
 * - Overall crawl progress (pages crawled, failed, pending)
 * - Real-time throughput metrics
 * - Active worker status
 * - Top domains by page count
 * - Recently crawled pages
 *
 * @module services/stats
 */

import { pool } from '../models/database.js';
import { redis, REDIS_KEYS } from '../models/redis.js';

/**
 * Comprehensive crawl statistics for the dashboard.
 * Combines real-time counters with database aggregations.
 */
export interface CrawlStats {
  /** Total pages successfully crawled across all workers (from Redis) */
  pagesCrawled: number;
  /** Total pages that failed to crawl (from Redis) */
  pagesFailed: number;
  /** Total bytes of content downloaded (from Redis) */
  bytesDownloaded: number;
  /** Total new URLs discovered from crawled pages (from Redis) */
  linksDiscovered: number;
  /** Number of duplicate URLs skipped (from Redis) */
  duplicatesSkipped: number;
  /** Pages whose content exactly duplicated an earlier page (from Redis) */
  duplicateContent: number;
  /** Discovered URLs dropped because their domain hit its page budget (from Redis) */
  budgetSkipped: number;

  /** URLs waiting to be crawled (from PostgreSQL) */
  frontierPending: number;
  /** URLs currently being processed by workers (from PostgreSQL) */
  frontierInProgress: number;
  /** URLs successfully completed (from PostgreSQL) */
  frontierCompleted: number;
  /** URLs that failed (from PostgreSQL) */
  frontierFailed: number;
  /** Total unique domains in the frontier (from PostgreSQL) */
  totalDomains: number;

  /** List of active worker IDs (from Redis) */
  activeWorkers: string[];
  /**
   * Worker heartbeats. `ageMs` is computed with the server's clock so the
   * dashboard never mixes the browser's clock with the workers' (a laptop
   * whose clock runs 40s fast would otherwise show every worker as stale).
   */
  workerHeartbeats: { workerId: string; lastHeartbeat: number; ageMs: number | null }[];
  /** Server time when this snapshot was produced (epoch ms) */
  generatedAt: number;

  /** Most recently crawled pages (from PostgreSQL) */
  recentPages: RecentPage[];
  /** Top domains by page count (from PostgreSQL) */
  topDomains: DomainStats[];
}

/**
 * Summary of a recently crawled page for the dashboard.
 */
export interface RecentPage {
  /** The URL that was crawled */
  url: string;
  /** Domain of the URL */
  domain: string;
  /** Extracted page title */
  title: string;
  /** HTTP status code */
  statusCode: number;
  /** ISO timestamp when crawled */
  crawledAt: string;
  /** Crawl duration in milliseconds */
  durationMs: number;
}

/**
 * Statistics for a single domain.
 */
export interface DomainStats {
  /** Domain hostname */
  domain: string;
  /** Number of pages crawled from this domain */
  pageCount: number;
  /** Crawl delay in seconds */
  crawlDelay: number;
}

/**
 * Statistics Service - aggregates and provides crawl metrics.
 *
 * This service is the primary data source for the dashboard, combining
 * data from Redis (real-time counters) and PostgreSQL (historical data).
 *
 * @example
 * ```typescript
 * import { statsService } from './services/stats';
 *
 * // Get comprehensive stats for the dashboard
 * const stats = await statsService.getStats();
 * console.log(`Crawled ${stats.pagesCrawled} pages across ${stats.totalDomains} domains`);
 *
 * // Get time-series data for charts
 * const timeSeries = await statsService.getTimeSeries(24); // Last 24 hours
 * ```
 */
export class StatsService {
  /**
   * Gets comprehensive crawl statistics.
   *
   * Fetches data from multiple sources in parallel for efficiency:
   * - Redis: Real-time counters and worker status
   * - PostgreSQL: Frontier status, recent pages, top domains
   *
   * @returns Complete CrawlStats object for dashboard display
   */
  async getStats(): Promise<CrawlStats> {
    // Get Redis counters
    const [
      pagesCrawled,
      pagesFailed,
      bytesDownloaded,
      linksDiscovered,
      duplicatesSkipped,
      duplicateContent,
      budgetSkipped,
      activeWorkers,
    ] = await Promise.all([
      redis.get(REDIS_KEYS.STATS_PAGES_CRAWLED),
      redis.get(REDIS_KEYS.STATS_PAGES_FAILED),
      redis.get(REDIS_KEYS.STATS_BYTES_DOWNLOADED),
      redis.get(REDIS_KEYS.STATS_LINKS_DISCOVERED),
      redis.get(REDIS_KEYS.STATS_DUPLICATES_SKIPPED),
      redis.get(REDIS_KEYS.STATS_DUPLICATE_CONTENT),
      redis.get(REDIS_KEYS.STATS_BUDGET_SKIPPED),
      redis.smembers(REDIS_KEYS.ACTIVE_WORKERS),
    ]);

    // Get worker heartbeats
    const workerHeartbeats = await Promise.all(
      activeWorkers.map(async (workerId) => {
        const heartbeat = await redis.get(REDIS_KEYS.WORKER_HEARTBEAT(workerId));
        const lastHeartbeat = heartbeat ? parseInt(heartbeat) : 0;
        return {
          workerId,
          lastHeartbeat,
          ageMs: lastHeartbeat ? Math.max(0, Date.now() - lastHeartbeat) : null,
        };
      })
    );

    // Get frontier stats from database
    const frontierStats = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM url_frontier
      GROUP BY status
    `);

    const frontierByStatus: Record<string, number> = {};
    for (const row of frontierStats.rows) {
      frontierByStatus[row.status] = parseInt(row.count);
    }

    // Get total domains
    const domainCountResult = await pool.query(
      'SELECT COUNT(DISTINCT domain) as count FROM url_frontier'
    );

    // Get recent pages
    const recentPagesResult = await pool.query(`
      SELECT url, domain, title, status_code, crawled_at, crawl_duration_ms
      FROM crawled_pages
      ORDER BY crawled_at DESC
      LIMIT 20
    `);

    const recentPages: RecentPage[] = recentPagesResult.rows.map((row) => ({
      url: row.url,
      domain: row.domain,
      title: row.title || '',
      statusCode: row.status_code,
      crawledAt: row.crawled_at,
      durationMs: row.crawl_duration_ms,
    }));

    // Get top domains by page count
    const topDomainsResult = await pool.query(`
      SELECT domain, page_count, crawl_delay
      FROM domains
      ORDER BY page_count DESC
      LIMIT 10
    `);

    const topDomains: DomainStats[] = topDomainsResult.rows.map((row) => ({
      domain: row.domain,
      pageCount: row.page_count,
      crawlDelay: row.crawl_delay,
    }));

    return {
      pagesCrawled: parseInt(pagesCrawled || '0'),
      pagesFailed: parseInt(pagesFailed || '0'),
      bytesDownloaded: parseInt(bytesDownloaded || '0'),
      linksDiscovered: parseInt(linksDiscovered || '0'),
      duplicatesSkipped: parseInt(duplicatesSkipped || '0'),
      duplicateContent: parseInt(duplicateContent || '0'),
      budgetSkipped: parseInt(budgetSkipped || '0'),

      frontierPending: frontierByStatus['pending'] || 0,
      frontierInProgress: frontierByStatus['in_progress'] || 0,
      frontierCompleted: frontierByStatus['completed'] || 0,
      frontierFailed: frontierByStatus['failed'] || 0,
      totalDomains: parseInt(domainCountResult.rows[0].count),

      activeWorkers,
      workerHeartbeats,

      recentPages,
      topDomains,
      generatedAt: Date.now(),
    };
  }

  /**
   * Gets time-series data for chart visualization.
   *
   * Aggregates crawl results by hour for the specified time window.
   * Useful for displaying crawl throughput trends over time.
   *
   * @param hours - Number of hours to look back (default: 24)
   * @returns Object containing arrays of timestamps and metrics
   */
  async getTimeSeries(hours: number = 24): Promise<{
    timestamps: string[];
    pagesCrawled: number[];
    pagesFailed: number[];
  }> {
    const result = await pool.query(
      `
      SELECT
        date_trunc('hour', crawled_at) as hour,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400) as success,
        COUNT(*) FILTER (WHERE status_code >= 400 OR status_code = 0) as failed
      FROM crawled_pages
      WHERE crawled_at >= NOW() - INTERVAL '1 hour' * $1
      GROUP BY date_trunc('hour', crawled_at)
      ORDER BY hour
    `,
      [hours]
    );

    return {
      timestamps: result.rows.map((r) => r.hour),
      pagesCrawled: result.rows.map((r) => parseInt(r.success)),
      pagesFailed: result.rows.map((r) => parseInt(r.failed)),
    };
  }

  /**
   * Resets all statistics counters in Redis.
   *
   * This is an admin function that clears the real-time counters.
   * Useful for starting fresh after testing or debugging.
   * Note: This does NOT delete data from PostgreSQL.
   */
  async resetStats(): Promise<void> {
    await Promise.all([
      redis.set(REDIS_KEYS.STATS_PAGES_CRAWLED, '0'),
      redis.set(REDIS_KEYS.STATS_PAGES_FAILED, '0'),
      redis.set(REDIS_KEYS.STATS_BYTES_DOWNLOADED, '0'),
      redis.set(REDIS_KEYS.STATS_LINKS_DISCOVERED, '0'),
      redis.set(REDIS_KEYS.STATS_DUPLICATES_SKIPPED, '0'),
      redis.set(REDIS_KEYS.STATS_DUPLICATE_CONTENT, '0'),
      redis.set(REDIS_KEYS.STATS_BUDGET_SKIPPED, '0'),
    ]);
  }
}

/**
 * Singleton instance of the StatsService.
 * Use this export for all statistics operations.
 */
export const statsService = new StatsService();
