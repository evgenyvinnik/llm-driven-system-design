import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { watchlistService, priceAlertService } from '../services/watchlistService.js';

/**
 * Express router for watchlist and price alert endpoints.
 * All routes require authentication.
 * Handles CRUD operations for watchlists, items, and price alerts.
 */
const router = Router();

// All watchlist routes require authentication
router.use(authMiddleware);

// ==================== WATCHLISTS ====================

/**
 * GET /api/watchlists
 * Returns all watchlists for the authenticated user with items and quotes.
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const watchlists = await watchlistService.getWatchlists(userId);
    res.json(watchlists);
  } catch (error) {
    console.error('Get watchlists error:', error);
    res.status(500).json({ error: 'Failed to fetch watchlists' });
  }
});

/**
 * POST /api/watchlists
 * Creates a new watchlist with the specified name.
 */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const watchlist = await watchlistService.createWatchlist(userId, name);
    res.status(201).json(watchlist);
  } catch (error) {
    console.error('Create watchlist error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/watchlists/:watchlistId
 * Deletes a watchlist and all its items.
 */
router.delete('/:watchlistId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await watchlistService.deleteWatchlist(userId, req.params.watchlistId);
    res.json({ message: 'Watchlist deleted' });
  } catch (error) {
    console.error('Delete watchlist error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/watchlists/:watchlistId/items
 * Adds a stock symbol to the specified watchlist.
 */
router.post('/:watchlistId/items', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { symbol } = req.body;

    if (!symbol) {
      res.status(400).json({ error: 'Symbol is required' });
      return;
    }

    const item = await watchlistService.addToWatchlist(
      userId,
      req.params.watchlistId,
      symbol
    );
    res.status(201).json(item);
  } catch (error) {
    console.error('Add to watchlist error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/watchlists/:watchlistId/items/:symbol
 * Removes a stock symbol from the specified watchlist.
 */
router.delete('/:watchlistId/items/:symbol', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await watchlistService.removeFromWatchlist(
      userId,
      req.params.watchlistId,
      req.params.symbol
    );
    res.json({ message: 'Symbol removed from watchlist' });
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

// ==================== PRICE ALERTS ====================

/**
 * GET /api/watchlists/alerts
 * Returns all price alerts for the authenticated user.
 */
router.get('/alerts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const alerts = await priceAlertService.getAlerts(userId);
    res.json(alerts);
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

/**
 * POST /api/watchlists/alerts
 * Creates a new price alert for a stock symbol.
 * Alerts trigger when price goes above or below target.
 */
router.post('/alerts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { symbol, targetPrice, condition } = req.body;

    if (!symbol || !targetPrice || !condition) {
      res.status(400).json({ error: 'symbol, targetPrice, and condition are required' });
      return;
    }

    if (!['above', 'below'].includes(condition)) {
      res.status(400).json({ error: 'condition must be "above" or "below"' });
      return;
    }

    const alert = await priceAlertService.createAlert(
      userId,
      symbol,
      parseFloat(targetPrice),
      condition
    );
    res.status(201).json(alert);
  } catch (error) {
    console.error('Create alert error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/watchlists/alerts/:alertId
 * Deletes a price alert.
 */
router.delete('/alerts/:alertId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await priceAlertService.deleteAlert(userId, req.params.alertId);
    res.json({ message: 'Alert deleted' });
  } catch (error) {
    console.error('Delete alert error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/watchlists/alerts/triggered
 * Returns recently triggered alerts stored in Redis.
 */
router.get('/alerts/triggered', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const triggered = await priceAlertService.getTriggeredAlerts(userId);
    res.json(triggered);
  } catch (error) {
    console.error('Get triggered alerts error:', error);
    res.status(500).json({ error: 'Failed to fetch triggered alerts' });
  }
});

/**
 * DELETE /api/watchlists/alerts/triggered
 * Clears all triggered alerts for the authenticated user.
 */
router.delete('/alerts/triggered', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await priceAlertService.clearTriggeredAlerts(userId);
    res.json({ message: 'Triggered alerts cleared' });
  } catch (error) {
    console.error('Clear triggered alerts error:', error);
    res.status(500).json({ error: 'Failed to clear triggered alerts' });
  }
});

export default router;
