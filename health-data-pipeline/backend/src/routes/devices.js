import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { deviceSyncService } from '../services/deviceSyncService.js';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Register a device
router.post('/', async (req, res) => {
  try {
    const { deviceType, deviceName, deviceIdentifier } = req.body;

    if (!deviceType || !deviceIdentifier) {
      return res.status(400).json({ error: 'deviceType and deviceIdentifier are required' });
    }

    const device = await deviceSyncService.registerDevice(req.user.id, {
      deviceType,
      deviceName,
      deviceIdentifier
    });

    res.status(201).json({ device });
  } catch (error) {
    console.error('Device registration error:', error);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// Get user's devices
router.get('/', async (req, res) => {
  try {
    const devices = await deviceSyncService.getUserDevices(req.user.id);
    res.json({ devices });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

// Sync health data from device
router.post('/:deviceId/sync', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { samples } = req.body;

    if (!Array.isArray(samples)) {
      return res.status(400).json({ error: 'samples must be an array' });
    }

    const result = await deviceSyncService.syncFromDevice(
      req.user.id,
      deviceId,
      samples
    );

    res.json(result);
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ error: 'Failed to sync data' });
  }
});

export default router;
