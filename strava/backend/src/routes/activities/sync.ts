import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth.js';
import { activityLogger as log, logError, ErrorWithCode } from '../../shared/logger.js';

const router = Router();

// External sync endpoints
// These endpoints handle syncing activities with external services (e.g., Garmin, Wahoo)

// Trigger sync with external service
router.post('/sync/:service', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const service = req.params.service as string;
    const userId = req.session.userId!;

    // Validate service
    const supportedServices = ['garmin', 'wahoo', 'zwift', 'polar'];
    if (!supportedServices.includes(service)) {
      res.status(400).json({
        error: `Unsupported service: ${service}`,
        supportedServices
      });
      return;
    }

    log.info({ userId, service }, 'Sync requested');

    // Placeholder: In production, this would initiate OAuth flow or API sync
    res.json({
      message: `Sync with ${service} initiated`,
      status: 'pending',
      note: 'External sync is not yet implemented'
    });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Sync error');
    res.status(500).json({ error: 'Failed to initiate sync' });
  }
});

// Get sync status
router.get('/sync/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.session.userId!;

    log.info({ userId }, 'Sync status requested');

    // Placeholder: Return mock sync status
    res.json({
      connectedServices: [],
      lastSync: null,
      pendingSyncs: 0,
      note: 'External sync is not yet implemented'
    });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Get sync status error');
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// Disconnect external service
router.delete('/sync/:service', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { service } = req.params;
    const userId = req.session.userId!;

    log.info({ userId, service }, 'Disconnect requested');

    res.json({
      message: `Disconnected from ${service}`,
      note: 'External sync is not yet implemented'
    });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Disconnect error');
    res.status(500).json({ error: 'Failed to disconnect service' });
  }
});

export default router;
