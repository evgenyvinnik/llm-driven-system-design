import { pool } from '../models/database.js';
import { redis, REDIS_KEYS } from '../models/redis.js';

export interface CrawlStats {
  // Overall stats
  pagesCrawled: number;
  pagesFailed: number;
  bytesDownloaded: number;
  linksDiscovered: number;
  duplicatesSkipped: number;

  // Frontier stats
  frontierPending: number;
  frontierInProgress: number;
  frontierCompleted: number;
  frontierFailed: number;
  totalDomains: number;

  // Worker stats
  activeWorkers: string[];
  workerHeartbeats: { workerId: string; lastHeartbeat: number }[];

  // Recent activity
  recentPages: RecentPage[];
  topDomains: DomainStats[];
}

export interface RecentPage {
  url: string;
  domain: string;
  title: string;
  statusCode: number;
  crawledAt: string;
  durationMs: number;
}

export interface DomainStats {
  domain: string;
  pageCount: number;
  crawlDelay: number;
}

/**
 * Statistics Service
 * Aggregates and provides crawl statistics for the dashboard
 */
export class StatsService {
  /**
   * Get comprehensive crawl statistics
   */
  async getStats(): Promise<CrawlStats> {
    // Get Redis counters
    const [
      pagesCrawled,
      pagesFailed,
      bytesDownloaded,
      linksDiscovered,
      duplicatesSkipped,
      activeWorkers,
    ] = await Promise.all([
      redis.get(REDIS_KEYS.STATS_PAGES_CRAWLED),
      redis.get(REDIS_KEYS.STATS_PAGES_FAILED),
      redis.get(REDIS_KEYS.STATS_BYTES_DOWNLOADED),
      redis.get(REDIS_KEYS.STATS_LINKS_DISCOVERED),
      redis.get(REDIS_KEYS.STATS_DUPLICATES_SKIPPED),
      redis.smembers(REDIS_KEYS.ACTIVE_WORKERS),
    ]);

    // Get worker heartbeats
    const workerHeartbeats = await Promise.all(
      activeWorkers.map(async (workerId) => {
        const heartbeat = await redis.get(REDIS_KEYS.WORKER_HEARTBEAT(workerId));
        return {
          workerId,
          lastHeartbeat: heartbeat ? parseInt(heartbeat) : 0,
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

      frontierPending: frontierByStatus['pending'] || 0,
      frontierInProgress: frontierByStatus['in_progress'] || 0,
      frontierCompleted: frontierByStatus['completed'] || 0,
      frontierFailed: frontierByStatus['failed'] || 0,
      totalDomains: parseInt(domainCountResult.rows[0].count),

      activeWorkers,
      workerHeartbeats,

      recentPages,
      topDomains,
    };
  }

  /**
   * Get time-series stats for charts
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
   * Reset all statistics
   */
  async resetStats(): Promise<void> {
    await Promise.all([
      redis.set(REDIS_KEYS.STATS_PAGES_CRAWLED, '0'),
      redis.set(REDIS_KEYS.STATS_PAGES_FAILED, '0'),
      redis.set(REDIS_KEYS.STATS_BYTES_DOWNLOADED, '0'),
      redis.set(REDIS_KEYS.STATS_LINKS_DISCOVERED, '0'),
      redis.set(REDIS_KEYS.STATS_DUPLICATES_SKIPPED, '0'),
    ]);
  }
}

export const statsService = new StatsService();
