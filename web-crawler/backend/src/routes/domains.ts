import { Router, Request, Response } from 'express';
import { pool } from '../models/database.js';
import { robotsService } from '../services/robots.js';

const router = Router();

/**
 * GET /api/domains
 * Get all crawled domains
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

    res.json({
      domains: result.rows,
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
 * Get details for a specific domain
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
 * Get robots.txt for a domain
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
 * Force refresh robots.txt for a domain
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
 * Update domain settings
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
