import { Router, Request, Response } from 'express';
import {
  getUserAlerts,
  markAlertAsRead,
  markAllAlertsAsRead,
  deleteAlert,
  getUnreadAlertCount,
} from '../services/alertService.js';
import { authMiddleware } from '../middleware/auth.js';

/**
 * Alert routes for managing price drop notifications.
 * All routes require authentication. Users can view, mark as read,
 * and delete alerts triggered by price changes.
 * @module routes/alerts
 */
const router = Router();

/** All alert routes require authentication */
router.use(authMiddleware);

/**
 * GET / - Retrieves all alerts for the authenticated user.
 * Query params: unread_only (boolean), limit (number, default: 50)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { unread_only, limit = '50' } = req.query;
    const alerts = await getUserAlerts(
      req.user!.id,
      unread_only === 'true',
      parseInt(limit as string, 10)
    );
    res.json({ alerts });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

/**
 * GET /count - Returns the count of unread alerts.
 * Used for notification badge in the header.
 */
router.get('/count', async (req: Request, res: Response) => {
  try {
    const count = await getUnreadAlertCount(req.user!.id);
    res.json({ count });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to fetch alert count' });
  }
});

/**
 * PATCH /:alertId/read - Marks a single alert as read.
 */
router.patch('/:alertId/read', async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const alert = await markAlertAsRead(alertId, req.user!.id);

    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    res.json({ alert });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to mark alert as read' });
  }
});

/**
 * POST /read-all - Marks all of user's alerts as read.
 * Convenience endpoint for clearing notification badge.
 */
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const count = await markAllAlertsAsRead(req.user!.id);
    res.json({ message: `Marked ${count} alerts as read` });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to mark alerts as read' });
  }
});

/**
 * DELETE /:alertId - Permanently deletes an alert.
 */
router.delete('/:alertId', async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const deleted = await deleteAlert(alertId, req.user!.id);

    if (!deleted) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    res.json({ message: 'Alert deleted' });
  } catch (_error) {
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

export default router;
