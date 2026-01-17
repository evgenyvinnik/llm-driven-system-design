import { Router, Request, Response } from 'express';
import { pool } from '../models/database.js';

const router = Router();

/**
 * GET /api/pages
 * Get recently crawled pages
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const domain = req.query.domain as string | undefined;
    const search = req.query.search as string | undefined;

    let query = `
      SELECT id, url, domain, title, description, status_code, content_type,
             content_length, links_count, crawled_at, crawl_duration_ms
      FROM crawled_pages
    `;
    const params: (string | number)[] = [];
    const conditions: string[] = [];

    if (domain) {
      conditions.push(`domain = $${params.length + 1}`);
      params.push(domain);
    }

    if (search) {
      conditions.push(
        `(url ILIKE $${params.length + 1} OR title ILIKE $${params.length + 1})`
      );
      params.push(`%${search}%`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY crawled_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM crawled_pages';
    if (conditions.length > 0) {
      countQuery +=
        ' WHERE ' +
        conditions.join(' AND ').replace(/\$(\d+)/g, (_, n) => `$${n}`);
    }
    const countResult = await pool.query(
      countQuery,
      params.slice(0, conditions.length > 0 ? (domain ? 1 : 0) + (search ? 1 : 0) : 0)
    );

    res.json({
      pages: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error getting pages:', error);
    res.status(500).json({ error: 'Failed to get pages' });
  }
});

/**
 * GET /api/pages/:urlHash
 * Get a specific crawled page by URL hash
 */
router.get('/:urlHash', async (req: Request, res: Response) => {
  try {
    const { urlHash } = req.params;

    const result = await pool.query(
      `SELECT * FROM crawled_pages WHERE url_hash = $1`,
      [urlHash]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Page not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error getting page:', error);
    res.status(500).json({ error: 'Failed to get page' });
  }
});

/**
 * GET /api/pages/domain/:domain
 * Get pages for a specific domain
 */
router.get('/domain/:domain', async (req: Request, res: Response) => {
  try {
    const { domain } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const result = await pool.query(
      `SELECT id, url, title, status_code, crawled_at, crawl_duration_ms
       FROM crawled_pages
       WHERE domain = $1
       ORDER BY crawled_at DESC
       LIMIT $2`,
      [domain, limit]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error getting domain pages:', error);
    res.status(500).json({ error: 'Failed to get domain pages' });
  }
});

export default router;
