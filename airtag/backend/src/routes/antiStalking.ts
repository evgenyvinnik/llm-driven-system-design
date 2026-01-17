import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { antiStalkingService } from '../services/antiStalkingService.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * POST /api/anti-stalking/sighting
 * Record a tracker sighting (when user's device detects a nearby unknown tracker)
 */
router.post('/sighting', async (req, res) => {
  try {
    const { identifier_hash, latitude, longitude } = req.body;

    if (!identifier_hash || !latitude || !longitude) {
      return res.status(400).json({
        error: 'Identifier hash, latitude, and longitude are required',
      });
    }

    const result = await antiStalkingService.recordSighting(
      req.session.userId!,
      identifier_hash,
      { latitude, longitude }
    );

    res.json({
      message: 'Sighting recorded',
      isAlert: result.isAlert,
      sighting_id: result.sighting.id,
    });
  } catch (error) {
    console.error('Record sighting error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/anti-stalking/unknown-trackers
 * Get all unknown trackers detected by the user
 */
router.get('/unknown-trackers', async (req, res) => {
  try {
    const trackers = await antiStalkingService.getUnknownTrackers(req.session.userId!);
    res.json(trackers);
  } catch (error) {
    console.error('Get unknown trackers error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/anti-stalking/sightings/:identifierHash
 * Get sighting history for a specific tracker
 */
router.get('/sightings/:identifierHash', async (req, res) => {
  try {
    const { identifierHash } = req.params;

    const sightings = await antiStalkingService.getSightings(
      req.session.userId!,
      identifierHash
    );

    res.json(sightings);
  } catch (error) {
    console.error('Get sightings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
