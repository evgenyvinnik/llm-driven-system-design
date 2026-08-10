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
import { pool } from '../models/database.js';
import { robotsService } from '../services/robots.js';

const router = Router();

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

    const result = await pool.query(
      `SELECT domain, page_count, crawl_delay, is_allowed, robots_fetched_at, created_at
       FROM domains
       ORDER BY ${sortColumn} ${order}
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) as count FROM domains');

    // camelCase to match the `Domain` type the frontend declares; raw rows would
    // leave pageCount/crawlDelay/isAllowed undefined in the table.
    res.json({
      domains: result.rows.map((row) => ({
        domain: row.domain,
        pageCount: row.page_count,
        crawlDelay: row.crawl_delay,
        isAllowed: row.is_allowed,
        robotsFetchedAt: row.robots_fetched_at,
        createdAt: row.created_at,
      })),
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

    const result = await pool.query(
      `SELECT * FROM domains WHERE domain = $1`,
      [domain]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }

    res.json(result.rows[0]);
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
router.post('/:domain/refresh-robots', async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;

    robotsService.clearCache(domain);
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
 * PUT /api/domains/:domain/settings
 *
 * Updates crawl settings for a specific domain.
 * Allows overriding the auto-detected crawl delay and
 * allowing/blocking a domain entirely.
 *
 * @param domain - Domain hostname
 * @body crawlDelay - Custom crawl delay in seconds
 * @body isAllowed - Whether crawling is allowed for this domain
 * @returns Success message
 */
router.put('/:domain/settings', async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;
    const { crawlDelay, isAllowed } = req.body;

    const updates: string[] = [];
    const params: (string | number | boolean)[] = [domain];

    if (crawlDelay !== undefined) {
      updates.push(`crawl_delay = $${params.length + 1}`);
      params.push(crawlDelay);
    }

    if (isAllowed !== undefined) {
      updates.push(`is_allowed = $${params.length + 1}`);
      params.push(isAllowed);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    updates.push('updated_at = NOW()');

    await pool.query(
      `UPDATE domains SET ${updates.join(', ')} WHERE domain = $1`,
      params
    );

    res.json({ message: 'Domain settings updated' });
  } catch (error) {
    console.error('Error updating domain settings:', error);
    res.status(500).json({ error: 'Failed to update domain settings' });
  }
});

export default router;
