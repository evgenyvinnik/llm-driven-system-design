/**
 * @fileoverview Express routes for crawler statistics.
 *
 * These endpoints provide access to crawl statistics and metrics for
 * the monitoring dashboard. All statistics are aggregated from Redis
 * (real-time counters) and PostgreSQL (historical data).
 *
 * @module routes/stats
 */

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { statsService } from '../services/stats.js';

const router = Router();

/**
 * GET /api/stats
 *
 * Returns comprehensive crawl statistics for the dashboard.
 * This is the primary endpoint for dashboard data, combining:
 * - Real-time counters (pages crawled, bytes downloaded)
 * - Frontier status (pending, in progress, completed, failed)
 * - Worker health (active workers, heartbeats)
 * - Recent activity (recent pages, top domains)
 *
 * @returns Complete CrawlStats object
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const stats = await statsService.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /api/stats/timeseries
 *
 * Returns time-series data for chart visualization.
 * Aggregates crawl results by hour for the specified time window.
 *
 * @query hours - Number of hours to look back (default: 24)
 * @returns Object with timestamps and page counts arrays
 */
router.get('/timeseries', async (req: Request, res: Response) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const timeSeries = await statsService.getTimeSeries(hours);
    res.json(timeSeries);
  } catch (error) {
    console.error('Error getting time series:', error);
    res.status(500).json({ error: 'Failed to get time series' });
  }
});

/**
 * POST /api/stats/reset
 *
 * Resets all statistics counters to zero.
 * This is an admin operation that affects only Redis counters.
 * Historical data in PostgreSQL is NOT affected.
 *
 * Useful for:
 * - Starting fresh after testing
 * - Resetting counters after data cleanup
 * - Debugging statistics issues
 *
 * @returns Success message
 */
router.post('/reset', requireAdmin, async (_req: Request, res: Response) => {
  try {
    await statsService.resetStats();
    res.json({ message: 'Stats reset successfully' });
  } catch (error) {
    console.error('Error resetting stats:', error);
    res.status(500).json({ error: 'Failed to reset stats' });
  }
});

export default router;
