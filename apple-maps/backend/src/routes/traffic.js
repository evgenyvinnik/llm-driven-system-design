import { Router } from 'express';
import trafficService from '../services/trafficService.js';
import logger from '../shared/logger.js';
import { idempotencyMiddleware } from '../shared/idempotency.js';
import { incidentReportLimiter, locationUpdateLimiter } from '../shared/rateLimit.js';

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
    logger.error({ error: error.message, path: '/api/traffic' }, 'Traffic fetch error');
    res.status(500).json({
      error: 'Failed to fetch traffic data',
    });
  }
});

/**
 * Ingest GPS probe for traffic aggregation
 * POST /api/traffic/probe
 *
 * This endpoint is idempotent - duplicate probes are ignored
 * Idempotency key: deviceId + timestamp
 */
router.post('/probe', locationUpdateLimiter, async (req, res) => {
  try {
    const { deviceId, latitude, longitude, speed, heading, timestamp } = req.body;

    if (!deviceId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        error: 'deviceId, latitude, and longitude are required',
      });
    }

    const result = await trafficService.ingestProbe({
      deviceId,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      speed: speed ? parseFloat(speed) : 0,
      heading: heading ? parseFloat(heading) : 0,
      timestamp: timestamp || Date.now(),
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error({ error: error.message, path: '/api/traffic/probe' }, 'GPS probe error');
    res.status(500).json({
      error: 'Failed to process GPS probe',
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
    logger.error({ error: error.message, path: '/api/traffic/incidents' }, 'Incidents fetch error');
    res.status(500).json({
      error: 'Failed to fetch incidents',
    });
  }
});

/**
 * Report an incident
 * POST /api/traffic/incidents
 *
 * This endpoint supports idempotency via:
 * - Idempotency-Key header (client-provided)
 * - clientRequestId in body
 *
 * Nearby incidents within 100m are merged rather than duplicated
 */
router.post(
  '/incidents',
  incidentReportLimiter,
  idempotencyMiddleware('incident_report'),
  async (req, res) => {
    try {
      const { lat, lng, type, severity, description, clientRequestId } = req.body;

      if (!lat || !lng || !type) {
        return res.status(400).json({
          error: 'Location (lat, lng) and type are required',
        });
      }

      const result = await trafficService.reportIncident({
        lat: parseFloat(lat),
        lng: parseFloat(lng),
        type,
        severity: severity || 'moderate',
        description,
        clientRequestId: clientRequestId || req.headers['idempotency-key'],
      });

      const statusCode = result.action === 'created' ? 201 : 200;

      res.status(statusCode).json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error({ error: error.message, path: '/api/traffic/incidents' }, 'Report incident error');
      res.status(500).json({
        error: 'Failed to report incident',
      });
    }
  }
);

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
    logger.error({ error: error.message, incidentId: req.params.id }, 'Resolve incident error');
    res.status(500).json({
      error: 'Failed to resolve incident',
    });
  }
});

export default router;
