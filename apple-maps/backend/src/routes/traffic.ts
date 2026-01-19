import { Router } from 'express';
import type { Request, Response } from 'express';
import trafficService from '../services/trafficService.js';
import logger from '../shared/logger.js';
import { idempotencyMiddleware } from '../shared/idempotency.js';
import { incidentReportLimiter, locationUpdateLimiter } from '../shared/rateLimit.js';

const router = Router();

interface BoundingBoxQuery {
  minLat?: string;
  minLng?: string;
  maxLat?: string;
  maxLng?: string;
}

interface ProbeRequestBody {
  deviceId?: string;
  latitude?: number | string;
  longitude?: number | string;
  speed?: number | string;
  heading?: number | string;
  timestamp?: number;
}

interface IncidentRequestBody {
  lat?: number | string;
  lng?: number | string;
  type?: string;
  severity?: string;
  description?: string;
  clientRequestId?: string;
}

/**
 * Get traffic in bounding box
 * GET /api/traffic?minLat=&minLng=&maxLat=&maxLng=
 */
router.get('/', async (req: Request<object, unknown, unknown, BoundingBoxQuery>, res: Response): Promise<void> => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    if (!minLat || !minLng || !maxLat || !maxLng) {
      res.status(400).json({
        error: 'Bounding box parameters required (minLat, minLng, maxLat, maxLng)',
      });
      return;
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
    logger.error({ error: (error as Error).message, path: '/api/traffic' }, 'Traffic fetch error');
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
router.post('/probe', locationUpdateLimiter, async (req: Request<object, unknown, ProbeRequestBody>, res: Response): Promise<void> => {
  try {
    const { deviceId, latitude, longitude, speed, heading, timestamp } = req.body;

    if (!deviceId || latitude === undefined || longitude === undefined) {
      res.status(400).json({
        error: 'deviceId, latitude, and longitude are required',
      });
      return;
    }

    const result = await trafficService.ingestProbe({
      deviceId,
      latitude: typeof latitude === 'string' ? parseFloat(latitude) : latitude,
      longitude: typeof longitude === 'string' ? parseFloat(longitude) : longitude,
      speed: speed ? (typeof speed === 'string' ? parseFloat(speed) : speed) : 0,
      heading: heading ? (typeof heading === 'string' ? parseFloat(heading) : heading) : 0,
      timestamp: timestamp || Date.now(),
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, path: '/api/traffic/probe' }, 'GPS probe error');
    res.status(500).json({
      error: 'Failed to process GPS probe',
    });
  }
});

/**
 * Get incidents in bounding box
 * GET /api/traffic/incidents?minLat=&minLng=&maxLat=&maxLng=
 */
router.get('/incidents', async (req: Request<object, unknown, unknown, BoundingBoxQuery>, res: Response): Promise<void> => {
  try {
    const { minLat, minLng, maxLat, maxLng } = req.query;

    if (!minLat || !minLng || !maxLat || !maxLng) {
      res.status(400).json({
        error: 'Bounding box parameters required',
      });
      return;
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
    logger.error({ error: (error as Error).message, path: '/api/traffic/incidents' }, 'Incidents fetch error');
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
  async (req: Request<object, unknown, IncidentRequestBody>, res: Response): Promise<void> => {
    try {
      const { lat, lng, type, severity, description, clientRequestId } = req.body;

      if (!lat || !lng || !type) {
        res.status(400).json({
          error: 'Location (lat, lng) and type are required',
        });
        return;
      }

      const idempotencyKey = req.headers['idempotency-key'];
      const result = await trafficService.reportIncident({
        lat: typeof lat === 'string' ? parseFloat(lat) : lat,
        lng: typeof lng === 'string' ? parseFloat(lng) : lng,
        type,
        severity: severity || 'moderate',
        description,
        clientRequestId: clientRequestId || (Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey),
      });

      const statusCode = result.action === 'created' ? 201 : 200;

      res.status(statusCode).json({
        success: true,
        ...result,
      });
    } catch (error) {
      logger.error({ error: (error as Error).message, path: '/api/traffic/incidents' }, 'Report incident error');
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
router.delete('/incidents/:id', async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try {
    await trafficService.resolveIncident(req.params.id);

    res.json({
      success: true,
      message: 'Incident resolved',
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, incidentId: req.params.id }, 'Resolve incident error');
    res.status(500).json({
      error: 'Failed to resolve incident',
    });
  }
});

export default router;
