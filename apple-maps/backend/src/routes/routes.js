import { Router } from 'express';
import routingService from '../services/routingService.js';
import logger from '../shared/logger.js';

const router = Router();

/**
 * Calculate route between two points
 * POST /api/routes
 */
router.post('/', async (req, res) => {
  try {
    const { origin, destination, options = {} } = req.body;

    if (!origin || !destination) {
      return res.status(400).json({
        error: 'Origin and destination are required',
      });
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
    logger.error({ error: error.message, path: '/api/routes' }, 'Route calculation error');
    res.status(500).json({
      error: error.message || 'Failed to calculate route',
    });
  }
});

/**
 * Get route with alternatives
 * POST /api/routes/alternatives
 */
router.post('/alternatives', async (req, res) => {
  try {
    const { origin, destination, options = {} } = req.body;

    if (!origin || !destination) {
      return res.status(400).json({
        error: 'Origin and destination are required',
      });
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
    logger.error({ error: error.message, path: '/api/routes/alternatives' }, 'Route alternatives error');
    res.status(500).json({
      error: error.message || 'Failed to calculate routes',
    });
  }
});

export default router;
