/**
 * @fileoverview Express routes for domain management.
 *
 * These endpoints provide API access to domain-level information:
 * - List of all crawled domains with statistics
 * - Domain-specific settings (crawl delay, allow/block)
 * - robots.txt content and refresh functionality
 *
 * @module routes/domains
 */

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { pool } from '../models/database.js';
import * as domainSettings from '../services/domainSettings.js';
import { config } from '../config.js';
import { robotsService } from '../services/robots.js';

const router = Router();

/** Columns selected for the Domain DTO (keep in sync with toDomainDto). */
const DOMAIN_COLUMNS =
  'domain, page_count, crawl_delay, crawl_delay_override, is_allowed, robots_fetched_at, created_at';

interface DomainRow {
  domain: string;
  page_count: number;
  crawl_delay: number | null;
  crawl_delay_override: number | null;
  is_allowed: boolean | null;
  robots_fetched_at: Date | null;
  created_at: Date;
}

/**
 * Maps a domains row to the camelCase DTO the frontend's `Domain` type declares.
 * `effectiveCrawlDelay` mirrors the worker rule: max(override, robots delay).
 */
function toDomainDto(row: DomainRow) {
  const robotsDelay = row.crawl_delay ?? config.crawler.defaultDelay / 1000;
  return {
    domain: row.domain,
    pageCount: row.page_count,
    crawlDelay: row.crawl_delay,
    crawlDelayOverride: row.crawl_delay_override,
    effectiveCrawlDelay:
      row.crawl_delay_override !== null
        ? Math.max(row.crawl_delay_override, robotsDelay)
        : robotsDelay,
    isAllowed: row.is_allowed !== false,
    robotsFetchedAt: row.robots_fetched_at,
    createdAt: row.created_at,
  };
}

/**
 * GET /api/domains
 *
 * Returns a paginated list of all crawled domains with statistics.
 * Used by the Domains view in the dashboard.
 *
 * @query limit - Maximum domains to return (default: 50, max: 100)
 * @query offset - Number of domains to skip for pagination
 * @query sortBy - Column to sort by (domain, page_count, crawl_delay, created_at)
 * @query order - Sort order (asc or desc, default: desc)
 * @returns Object with domains array, total count, and pagination info
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const sortBy = (req.query.sortBy as string) || 'page_count';
    const order = (req.query.order as string) === 'asc' ? 'ASC' : 'DESC';

    const validSortColumns = ['domain', 'page_count', 'crawl_delay', 'created_at'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'page_count';

    const result = await pool.query<DomainRow>(
      `SELECT ${DOMAIN_COLUMNS}
       FROM domains
       ORDER BY ${sortColumn} ${order}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) as count FROM domains');

    // camelCase to match the `Domain` type the frontend declares; raw rows would
    // leave pageCount/crawlDelay/isAllowed undefined in the table.
    res.json({
      domains: result.rows.map(toDomainDto),
      total: parseInt(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error getting domains:', error);
    res.status(500).json({ error: 'Failed to get domains' });
  }
});

/**
 * GET /api/domains/:domain
 *
 * Returns detailed information about a specific domain.
 * Includes all columns from the domains table.
 *
 * @param domain - Domain hostname to look up
 * @returns Complete domain record
 */
router.get('/:domain', async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;

    const result = await pool.query<DomainRow & { robots_txt: string | null }>(
      `SELECT ${DOMAIN_COLUMNS}, robots_txt FROM domains WHERE domain = $1`,
      [domain]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }

    // Same DTO as the list endpoint (raw rows leak snake_case to the client)
    res.json({ ...toDomainDto(result.rows[0]), robotsTxt: result.rows[0].robots_txt });
  } catch (error) {
    console.error('Error getting domain:', error);
    res.status(500).json({ error: 'Failed to get domain' });
  }
});

/**
 * GET /api/domains/:domain/robots
 *
 * Returns the cached robots.txt content for a domain.
 * Useful for debugging crawl permission issues.
 *
 * @param domain - Domain hostname
 * @returns Object with domain, robotsTxt content, and fetch timestamp
 */
router.get('/:domain/robots', async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;

    const result = await pool.query(
      `SELECT robots_txt, robots_fetched_at FROM domains WHERE domain = $1`,
      [domain]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }

    res.json({
      domain,
      robotsTxt: result.rows[0].robots_txt,
      fetchedAt: result.rows[0].robots_fetched_at,
    });
  } catch (error) {
    console.error('Error getting robots.txt:', error);
    res.status(500).json({ error: 'Failed to get robots.txt' });
  }
});

/**
 * POST /api/domains/:domain/refresh-robots
 *
 * Forces a fresh fetch of robots.txt for a domain.
 * Clears all caches (memory, Redis) and fetches from the network.
 *
 * Use this when:
 * - A site has updated their robots.txt
 * - Cache appears stale or incorrect
 * - Debugging permission issues
 *
 * @param domain - Domain hostname
 * @returns Updated robots.txt info including new content and crawl delay
 */
router.post('/:domain/refresh-robots', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;

    await robotsService.clearCache(domain);
    await robotsService.getParser(domain);

    const result = await pool.query(
      `SELECT robots_txt, robots_fetched_at, crawl_delay FROM domains WHERE domain = $1`,
      [domain]
    );

    res.json({
      domain,
      robotsTxt: result.rows[0]?.robots_txt,
      fetchedAt: result.rows[0]?.robots_fetched_at,
      crawlDelay: result.rows[0]?.crawl_delay,
    });
  } catch (error) {
    console.error('Error refreshing robots.txt:', error);
    res.status(500).json({ error: 'Failed to refresh robots.txt' });
  }
});

/**
 * PUT /api/domains/:domain/settings  (admin)
 *
 * Updates operator settings for a domain:
 * - `crawlDelay`: override in seconds, or null to remove the override. Workers
 *   use max(override, robots.txt delay), so an override can only slow a
 *   domain down.
 * - `isAllowed`: false blocks the domain; workers fail its URLs permanently.
 *
 * Written to PostgreSQL first (durable), then published to Redis (what workers
 * read). If the publish fails the request errors; the maintenance loop also
 * republishes blocks/overrides from Postgres every interval.
 *
 * @returns The updated domain DTO
 */
router.put('/:domain/settings', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;
    const { crawlDelay, isAllowed } = req.body ?? {};

    const updates: string[] = [];
    const params: (string | number | boolean | null)[] = [domain];

    if (crawlDelay !== undefined) {
      let override: number | null = null;
      if (crawlDelay !== null) {
        override = Number(crawlDelay);
        if (!Number.isFinite(override) || override <= 0 || override > 3600) {
          res.status(400).json({ error: 'crawlDelay must be null or a number of seconds in (0, 3600]' });
          return;
        }
      }
      updates.push(`crawl_delay_override = $${params.length + 1}`);
      params.push(override);
    }

    if (isAllowed !== undefined) {
      if (typeof isAllowed !== 'boolean') {
        res.status(400).json({ error: 'isAllowed must be a boolean' });
        return;
      }
      updates.push(`is_allowed = $${params.length + 1}`);
      params.push(isAllowed);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    updates.push('updated_at = NOW()');

    const result = await pool.query<DomainRow>(
      `UPDATE domains SET ${updates.join(', ')} WHERE domain = $1
       RETURNING ${DOMAIN_COLUMNS}`,
      params
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }

    const row = result.rows[0];
    await domainSettings.publish(domain, {
      crawlDelayOverride: row.crawl_delay_override,
      isAllowed: row.is_allowed !== false,
    });

    res.json(toDomainDto(row));
  } catch (error) {
    console.error('Error updating domain settings:', error);
    res.status(500).json({ error: 'Failed to update domain settings' });
  }
});

export default router;
