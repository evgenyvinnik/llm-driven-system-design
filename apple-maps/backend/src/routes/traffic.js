import { Router } from 'express';
import trafficService from '../services/trafficService.js';

const router = Router();

/**
 * Get traffic in bounding box
 * GET /api/traffic?minLat=&minLng=&maxLat=&maxLng=
 */
router.get('/', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    if (!minLat || !minLng || !maxLat || !maxLng) {
      return res.status(400).json({
        error: 'Bounding box parameters required (minLat, minLng, maxLat, maxLng)',
      });
    }

    const traffic = await trafficService.getTrafficInBounds(
      parseFloat(minLat),
      parseFloat(minLng),
      parseFloat(maxLat),
      parseFloat(maxLng)
    );

    res.json({
      success: true,
      traffic,
    });
  } catch (error) {
    console.error('Traffic fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch traffic data',
    });
  }
});

/**
 * Get incidents in bounding box
 * GET /api/traffic/incidents?minLat=&minLng=&maxLat=&maxLng=
 */
router.get('/incidents', async (req, res) => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    if (!minLat || !minLng || !maxLat || !maxLng) {
      return res.status(400).json({
        error: 'Bounding box parameters required',
      });
    }

    const incidents = await trafficService.getIncidents(
      parseFloat(minLat),
      parseFloat(minLng),
      parseFloat(maxLat),
      parseFloat(maxLng)
    );

    res.json({
      success: true,
      incidents,
    });
  } catch (error) {
    console.error('Incidents fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch incidents',
    });
  }
});

/**
 * Report an incident
 * POST /api/traffic/incidents
 */
router.post('/incidents', async (req, res) => {
  try {
    const { lat, lng, type, severity, description } = req.body;

    if (!lat || !lng || !type) {
      return res.status(400).json({
        error: 'Location (lat, lng) and type are required',
      });
    }

    const incident = await trafficService.reportIncident({
      lat,
      lng,
      type,
      severity: severity || 'moderate',
      description,
    });

    res.status(201).json({
      success: true,
      incident,
    });
  } catch (error) {
    console.error('Report incident error:', error);
    res.status(500).json({
      error: 'Failed to report incident',
    });
  }
});

/**
 * Resolve an incident
 * DELETE /api/traffic/incidents/:id
 */
router.delete('/incidents/:id', async (req, res) => {
  try {
    await trafficService.resolveIncident(req.params.id);

    res.json({
      success: true,
      message: 'Incident resolved',
    });
  } catch (error) {
    console.error('Resolve incident error:', error);
    res.status(500).json({
      error: 'Failed to resolve incident',
    });
  }
});

export default router;
