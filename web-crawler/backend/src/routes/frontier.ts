import { Router, Request, Response } from 'express';
import { frontierService } from '../services/frontier.js';
import { pool } from '../models/database.js';

const router = Router();

/**
 * GET /api/frontier/stats
 * Get frontier statistics
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
 * Get recent URLs from frontier
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
 * Add URLs to the frontier
 */
router.post('/add', async (req: Request, res: Response) => {
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
 * Add seed URLs (for initial crawl)
 */
router.post('/seed', async (req: Request, res: Response) => {
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
 * Recover stale in-progress URLs
 */
router.post('/recover', async (req: Request, res: Response) => {
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
 * Clear the frontier (admin only)
 */
router.delete('/clear', async (_req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM url_frontier');
    res.json({ message: 'Frontier cleared' });
  } catch (error) {
    console.error('Error clearing frontier:', error);
    res.status(500).json({ error: 'Failed to clear frontier' });
  }
});

export default router;
