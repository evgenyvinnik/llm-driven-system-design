import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { watchlistService, priceAlertService } from '../services/watchlistService.js';

const router = Router();

// All watchlist routes require authentication
router.use(authMiddleware);

// ==================== WATCHLISTS ====================

// Get all watchlists
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

// Create new watchlist
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

// Delete watchlist
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

// Add symbol to watchlist
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

// Remove symbol from watchlist
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

// Get all alerts
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

// Create alert
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

// Delete alert
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

// Get triggered alerts (from Redis)
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

// Clear triggered alerts
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
