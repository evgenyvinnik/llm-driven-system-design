import express, { Request, Response, Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { deviceSyncService, SyncResult } from '../services/deviceSyncService.js';
import { HealthSampleData } from '../models/healthSample.js';
import { logger } from '../shared/logger.js';
import { checkIdempotency, storeIdempotencyKey, generateIdempotencyKey } from '../shared/idempotency.js';
import { samplesIngestedTotal, syncDuration, createTimer } from '../shared/metrics.js';

const router: Router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Register a device
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { deviceType, deviceName, deviceIdentifier } = req.body as {
      deviceType?: string;
      deviceName?: string;
      deviceIdentifier?: string;
    };

    if (!deviceType || !deviceIdentifier) {
      res.status(400).json({ error: 'deviceType and deviceIdentifier are required' });
      return;
    }

    const device = await deviceSyncService.registerDevice(req.user!.id, {
      deviceType,
      deviceName: deviceName || '',
      deviceIdentifier
    });

    logger.info({
      msg: 'Device registered',
      userId: req.user!.id,
      deviceId: device.id,
      deviceType
    });

    res.status(201).json({ device });
  } catch (error) {
    logger.error({
      msg: 'Device registration error',
      userId: req.user?.id,
      error: (error as Error).message
    });
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// Get user's devices
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const devices = await deviceSyncService.getUserDevices(req.user!.id);
    res.json({ devices });
  } catch (error) {
    logger.error({
      msg: 'Get devices error',
      userId: req.user?.id,
      error: (error as Error).message
    });
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

// Sync health data from device
// Supports idempotency via X-Idempotency-Key header or auto-generated key
router.post('/:deviceId/sync', async (req: Request, res: Response): Promise<void> => {
  try {
    const deviceId = req.params.deviceId as string;
    const { samples } = req.body as { samples?: HealthSampleData[] };

    if (!Array.isArray(samples)) {
      res.status(400).json({ error: 'samples must be an array' });
      return;
    }

    // Check for idempotency key (from header or generate from content)
    let idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
    if (!idempotencyKey && samples.length > 0) {
      // Auto-generate key from content for duplicate detection
      idempotencyKey = generateIdempotencyKey(req.user!.id, deviceId, samples);
    }

    // Check if this is a duplicate request
    if (idempotencyKey) {
      const { isDuplicate, cachedResponse } = await checkIdempotency(idempotencyKey);
      if (isDuplicate) {
        logger.info({
          msg: 'Duplicate sync request detected',
          userId: req.user!.id,
          deviceId,
          idempotencyKey
        });
        res.json(cachedResponse);
        return;
      }
    }

    // Start timing the sync operation
    const endTimer = createTimer(syncDuration, { device_type: 'unknown' });

    const result = await deviceSyncService.syncFromDevice(
      req.user!.id,
      deviceId as string,
      samples
    );

    const durationSeconds = endTimer();

    // Record metrics
    samplesIngestedTotal.inc(
      { type: 'mixed', device_type: 'unknown', status: 'success' },
      result.synced
    );
    if (result.errors > 0) {
      samplesIngestedTotal.inc(
        { type: 'mixed', device_type: 'unknown', status: 'error' },
        result.errors
      );
    }

    logger.info({
      msg: 'Health data sync completed',
      userId: req.user!.id,
      deviceId,
      synced: result.synced,
      errors: result.errors,
      durationMs: Math.round(durationSeconds * 1000)
    });

    // Store response for idempotency
    if (idempotencyKey) {
      await storeIdempotencyKey(idempotencyKey, result);
    }

    res.json(result);
  } catch (error) {
    logger.error({
      msg: 'Sync error',
      userId: req.user?.id,
      deviceId: req.params.deviceId,
      error: (error as Error).message,
      stack: (error as Error).stack
    });
    res.status(500).json({ error: 'Failed to sync data' });
  }
});

export default router;
