import { Router, Request, Response } from 'express';
import {
  getUserAlerts,
  markAlertAsRead,
  markAllAlertsAsRead,
  deleteAlert,
  getUnreadAlertCount,
} from '../services/alertService.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Get user's alerts
router.get('/', async (req: Request, res: Response) => {
  try {
    const { unread_only, limit = '50' } = req.query;
    const alerts = await getUserAlerts(
      req.user!.id,
      unread_only === 'true',
      parseInt(limit as string, 10)
    );
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Get unread alert count
router.get('/count', async (req: Request, res: Response) => {
  try {
    const count = await getUnreadAlertCount(req.user!.id);
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch alert count' });
  }
});

// Mark alert as read
router.patch('/:alertId/read', async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const alert = await markAlertAsRead(alertId, req.user!.id);

    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    res.json({ alert });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark alert as read' });
  }
});

// Mark all alerts as read
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const count = await markAllAlertsAsRead(req.user!.id);
    res.json({ message: `Marked ${count} alerts as read` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark alerts as read' });
  }
});

// Delete alert
router.delete('/:alertId', async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    const deleted = await deleteAlert(alertId, req.user!.id);

    if (!deleted) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    res.json({ message: 'Alert deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});

export default router;
