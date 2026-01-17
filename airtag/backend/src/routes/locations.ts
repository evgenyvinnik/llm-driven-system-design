import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { locationService } from '../services/locationService.js';
import { SimulatedLocation } from '../types/index.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/locations/:deviceId
 * Get location history for a device
 */
router.get('/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { startTime, endTime, limit } = req.query;

    const options: { startTime?: number; endTime?: number; limit?: number } = {};

    if (startTime) {
      options.startTime = parseInt(startTime as string);
    }
    if (endTime) {
      options.endTime = parseInt(endTime as string);
    }
    if (limit) {
      options.limit = parseInt(limit as string);
    }

    const locations = await locationService.getDeviceLocations(
      deviceId,
      req.session.userId!,
      options
    );

    res.json(locations);
  } catch (error) {
    console.error('Get locations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/locations/:deviceId/latest
 * Get the latest location for a device
 */
router.get('/:deviceId/latest', async (req, res) => {
  try {
    const { deviceId } = req.params;

    const location = await locationService.getLatestLocation(
      deviceId,
      req.session.userId!
    );

    if (!location) {
      return res.status(404).json({ error: 'No location found' });
    }

    res.json(location);
  } catch (error) {
    console.error('Get latest location error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/locations/:deviceId/simulate
 * Simulate a location report (for testing/demo)
 */
router.post('/:deviceId/simulate', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const location: SimulatedLocation = req.body;

    if (!location.latitude || !location.longitude) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    const report = await locationService.simulateLocationReport(
      deviceId,
      req.session.userId!,
      location
    );

    if (!report) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.status(201).json({
      message: 'Location simulated successfully',
      report_id: report.id,
    });
  } catch (error) {
    console.error('Simulate location error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/locations/report
 * Submit a location report from a finder device (crowd-sourced network)
 * This endpoint would be used by other devices in the Find My network
 */
router.post('/report', async (req, res) => {
  try {
    const { identifier_hash, encrypted_payload, reporter_region } = req.body;

    if (!identifier_hash || !encrypted_payload) {
      return res.status(400).json({ error: 'Identifier hash and encrypted payload are required' });
    }

    const report = await locationService.submitReport({
      identifier_hash,
      encrypted_payload,
      reporter_region,
    });

    res.status(201).json({
      message: 'Report submitted successfully',
      report_id: report.id,
    });
  } catch (error) {
    console.error('Submit report error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
