import { Router } from 'express';
import type { Request, Response } from 'express';
import routingService from '../services/routingService.js';
import logger from '../shared/logger.js';

const router = Router();

interface RouteRequestBody {
  origin?: {
    lat: number;
    lng: number;
  };
  destination?: {
    lat: number;
    lng: number;
  };
  options?: {
    avoidTolls?: boolean;
    avoidHighways?: boolean;
  };
}

/**
 * Calculate route between two points
 * POST /api/routes
 */
router.post('/', async (req: Request<object, unknown, RouteRequestBody>, res: Response): Promise<void> => {
  try {
    const { origin, destination, options = {} } = req.body;

    if (!origin || !destination) {
      res.status(400).json({
        error: 'Origin and destination are required',
      });
      return;
    }

    const route = await routingService.findRoute(
      origin.lat,
      origin.lng,
      destination.lat,
      destination.lng,
      options
    );

    res.json({
      success: true,
      route,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, path: '/api/routes' }, 'Route calculation error');
    res.status(500).json({
      error: (error as Error).message || 'Failed to calculate route',
    });
  }
});

/**
 * Get route with alternatives
 * POST /api/routes/alternatives
 */
router.post('/alternatives', async (req: Request<object, unknown, RouteRequestBody>, res: Response): Promise<void> => {
  try {
    const { origin, destination, options = {} } = req.body;

    if (!origin || !destination) {
      res.status(400).json({
        error: 'Origin and destination are required',
      });
      return;
    }

    const primaryRoute = await routingService.findRoute(
      origin.lat,
      origin.lng,
      destination.lat,
      destination.lng,
      options
    );

    const alternatives = await routingService.findAlternatives(
      origin.lat,
      origin.lng,
      destination.lat,
      destination.lng,
      primaryRoute,
      options
    );

    res.json({
      success: true,
      routes: [primaryRoute, ...alternatives],
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, path: '/api/routes/alternatives' }, 'Route alternatives error');
    res.status(500).json({
      error: (error as Error).message || 'Failed to calculate routes',
    });
  }
});

export default router;
