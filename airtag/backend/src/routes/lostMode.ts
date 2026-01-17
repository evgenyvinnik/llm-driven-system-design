import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { lostModeService } from '../services/lostModeService.js';
import { LostModeRequest } from '../types/index.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/lost-mode/:deviceId
 * Get lost mode settings for a device
 */
router.get('/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;

    const lostMode = await lostModeService.getLostMode(deviceId, req.session.userId!);

    if (!lostMode) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(lostMode);
  } catch (error) {
    console.error('Get lost mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/lost-mode/:deviceId
 * Update lost mode settings for a device
 */
router.put('/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const data: LostModeRequest = req.body;

    if (typeof data.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled status is required' });
    }

    const lostMode = await lostModeService.updateLostMode(
      deviceId,
      req.session.userId!,
      data
    );

    if (!lostMode) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(lostMode);
  } catch (error) {
    console.error('Update lost mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/lost-mode/:deviceId/enable
 * Quick enable lost mode
 */
router.post('/:deviceId/enable', async (req, res) => {
  try {
    const { deviceId } = req.params;

    const lostMode = await lostModeService.enableLostMode(deviceId, req.session.userId!);

    if (!lostMode) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json({
      message: 'Lost mode enabled',
      ...lostMode,
    });
  } catch (error) {
    console.error('Enable lost mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/lost-mode/:deviceId/disable
 * Disable lost mode
 */
router.post('/:deviceId/disable', async (req, res) => {
  try {
    const { deviceId } = req.params;

    const lostMode = await lostModeService.disableLostMode(deviceId, req.session.userId!);

    if (!lostMode) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json({
      message: 'Lost mode disabled',
      ...lostMode,
    });
  } catch (error) {
    console.error('Disable lost mode error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
