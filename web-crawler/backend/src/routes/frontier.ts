/**
 * @fileoverview Express routes for URL frontier management.
 *
 * These endpoints provide API access to the URL frontier - the queue of URLs
 * to be crawled. The API supports:
 * - Viewing frontier statistics and URL list
 * - Adding new URLs to the crawl queue
 * - Adding seed URLs for starting new crawl sessions
 * - Recovery operations for stale URLs
 * - Administrative clearing of the frontier
 *
 * @module routes/frontier
 */

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { frontierService } from '../services/frontier.js';
import { pool } from '../models/database.js';

const router = Router();

/**
 * GET /api/frontier/stats
 *
 * Returns aggregated statistics about the URL frontier.
 * Used by the dashboard to display queue status.
 *
 * @returns Frontier stats including counts by status and total domains
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await frontierService.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting frontier stats:', error);
    res.status(500).json({ error: 'Failed to get frontier stats' });
  }
});

/**
 * GET /api/frontier/urls
 *
 * Returns a list of URLs from the frontier with optional filtering.
 * Used by the dashboard to display the URL queue.
 *
 * @query limit - Maximum URLs to return (default: 50)
 * @query status - Filter by status (pending, in_progress, completed, failed)
 * @returns Array of frontier URL objects
 */
router.get('/urls', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const status = req.query.status as string | undefined;

    const urls = await frontierService.getRecentUrls(limit, status);
    res.json(urls);
  } catch (error) {
    console.error('Error getting frontier URLs:', error);
    res.status(500).json({ error: 'Failed to get frontier URLs' });
  }
});

/**
 * POST /api/frontier/add
 *
 * Adds URLs to the frontier for crawling.
 * Duplicates and non-crawlable URLs are automatically filtered.
 *
 * @body urls - Array of URL strings to add
 * @body priority - Optional priority level (1-3, default: calculated)
 * @returns Object with count of added URLs and total submitted
 */
router.post('/add', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { urls, priority } = req.body;

    if (!urls || !Array.isArray(urls)) {
      res.status(400).json({ error: 'URLs array is required' });
      return;
    }

    const added = await frontierService.addUrls(urls, { priority });
    res.json({ added, total: urls.length });
  } catch (error) {
    console.error('Error adding URLs to frontier:', error);
    res.status(500).json({ error: 'Failed to add URLs' });
  }
});

/**
 * POST /api/frontier/seed
 *
 * Adds high-priority seed URLs to start a new crawl.
 * Seed URLs are stored in a separate table for reference and
 * added to the frontier with maximum priority (3).
 *
 * Use this endpoint to initiate crawling of new domains.
 *
 * @body urls - Array of seed URL strings
 * @body priority - Priority level (default: 3 - high)
 * @returns Object with count of added URLs and total submitted
 */
router.post('/seed', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { urls, priority = 3 } = req.body;

    if (!urls || !Array.isArray(urls)) {
      res.status(400).json({ error: 'URLs array is required' });
      return;
    }

    // Add to seed_urls table
    for (const url of urls) {
      await pool.query(
        `INSERT INTO seed_urls (url, priority) VALUES ($1, $2)
         ON CONFLICT (url) DO UPDATE SET priority = EXCLUDED.priority`,
        [url, priority]
      );
    }

    // Add to frontier
    const added = await frontierService.addUrls(urls, { priority, depth: 0 });
    res.json({ added, total: urls.length });
  } catch (error) {
    console.error('Error adding seed URLs:', error);
    res.status(500).json({ error: 'Failed to add seed URLs' });
  }
});

/**
 * POST /api/frontier/recover
 *
 * Recovers stale in-progress URLs that may be stuck due to worker crashes.
 * Resets URLs that have been in_progress longer than the specified time.
 *
 * This is a maintenance operation that should be run periodically or
 * after restarting workers.
 *
 * @query minutes - Age threshold in minutes (default: 10)
 * @returns Object with count of recovered URLs
 */
router.post('/recover', requireAdmin, async (req: Request, res: Response) => {
  try {
    const minutes = parseInt(req.query.minutes as string) || 10;
    const recovered = await frontierService.recoverStaleUrls(minutes);
    res.json({ recovered });
  } catch (error) {
    console.error('Error recovering URLs:', error);
    res.status(500).json({ error: 'Failed to recover URLs' });
  }
});

/**
 * DELETE /api/frontier/clear
 *
 * Clears the entire URL frontier. This is a destructive admin operation
 * that cannot be undone - use with caution.
 *
 * Does NOT clear:
 * - Crawled pages (historical data)
 * - Visited URL set in Redis (for deduplication)
 * - Statistics counters
 *
 * @returns Success message
 */
router.delete('/clear', requireAdmin, async (_req: Request, res: Response) => {
  try {
    await frontierService.clear();
    res.json({ message: 'Frontier cleared' });
  } catch (error) {
    console.error('Error clearing frontier:', error);
    res.status(500).json({ error: 'Failed to clear frontier' });
  }
});

export default router;
