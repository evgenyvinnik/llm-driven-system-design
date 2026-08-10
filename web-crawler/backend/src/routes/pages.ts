/**
 * @fileoverview Express routes for browsing crawled pages.
 *
 * These endpoints provide API access to the crawled_pages table,
 * allowing the dashboard to display and search through crawled content.
 * Supports pagination, domain filtering, and text search.
 *
 * @module routes/pages
 */

import { Router, Request, Response } from 'express';
import { pool } from '../models/database.js';

const router = Router();

/**
 * GET /api/pages
 *
 * Returns a paginated list of crawled pages with optional filtering.
 * Used by the Pages view in the dashboard to browse crawled content.
 *
 * @query limit - Maximum pages to return (default: 50, max: 100)
 * @query offset - Number of pages to skip for pagination
 * @query domain - Filter by specific domain
 * @query search - Search in URL and title (case-insensitive)
 * @returns Object with pages array, total count, and pagination info
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
    // The count query reuses the filter params but not LIMIT/OFFSET, which are
    // always the last two pushed. Slicing them off is exact; recomputing the
    // filter count separately would drift the moment a third filter is added.
    const countResult = await pool.query(countQuery, params.slice(0, params.length - 2));

    // Postgres returns snake_case; the API contract (and `CrawledPage` in the
    // frontend types) is camelCase. Returning `result.rows` verbatim meant every
    // one of these fields arrived undefined, which the UI rendered as
    // "undefined B", a bare "ms", and "Invalid Date" on every row.
    res.json({
      pages: result.rows.map((row) => ({
        id: row.id,
        url: row.url,
        domain: row.domain,
        title: row.title,
        description: row.description,
        statusCode: row.status_code,
        contentType: row.content_type,
        contentLength: row.content_length,
        linksCount: row.links_count,
        crawledAt: row.crawled_at,
        crawlDurationMs: row.crawl_duration_ms,
      })),
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
 *
 * Returns details of a specific crawled page by its URL hash.
 * The URL hash is the SHA-256 hash of the normalized URL.
 *
 * @param urlHash - SHA-256 hash of the page URL
 * @returns Complete page record including all metadata
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
 *
 * Returns all crawled pages for a specific domain.
 * Useful for exploring content from a single site.
 *
 * @param domain - Domain hostname to filter by
 * @query limit - Maximum pages to return (default: 50, max: 100)
 * @returns Array of page records for the domain
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

    // Same camelCase contract as the list endpoint above.
    res.json(
      result.rows.map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title,
        statusCode: row.status_code,
        crawledAt: row.crawled_at,
        crawlDurationMs: row.crawl_duration_ms,
      }))
    );
  } catch (error) {
    console.error('Error getting domain pages:', error);
    res.status(500).json({ error: 'Failed to get domain pages' });
  }
});

export default router;
