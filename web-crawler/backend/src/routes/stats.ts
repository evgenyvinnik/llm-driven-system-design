import { Router, Request, Response } from 'express';
import { statsService } from '../services/stats.js';

const router = Router();

/**
 * GET /api/stats
 * Get comprehensive crawl statistics
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
 * Get time-series data for charts
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
 * Reset all statistics (admin only)
 */
router.post('/reset', async (_req: Request, res: Response) => {
  try {
    await statsService.resetStats();
    res.json({ message: 'Stats reset successfully' });
  } catch (error) {
    console.error('Error resetting stats:', error);
    res.status(500).json({ error: 'Failed to reset stats' });
  }
});

export default router;
