import { Router } from 'express';
import type { Request, Response } from 'express';
import searchService from '../services/searchService.js';
import logger from '../shared/logger.js';

const router = Router();

interface SearchQuery {
  q?: string;
  lat?: string;
  lng?: string;
  radius?: string;
  category?: string;
  limit?: string;
}

interface GeocodeQuery {
  address?: string;
}

interface ReverseGeocodeQuery {
  lat?: string;
  lng?: string;
}

/**
 * Search for places
 * GET /api/search?q=&lat=&lng=&radius=&category=&limit=
 */
router.get('/', async (req: Request<object, unknown, unknown, SearchQuery>, res: Response): Promise<void> => {
  try {
    const { q, lat, lng, radius, category, limit } = req.query;

    if (!q && !category && !lat) {
      res.status(400).json({
        error: 'Search query (q), category, or location required',
      });
      return;
    }

    const places = await searchService.searchPlaces(q || '', {
      lat: lat ? parseFloat(lat) : undefined,
      lng: lng ? parseFloat(lng) : undefined,
      radius: radius ? parseFloat(radius) : 5000,
      category,
      limit: limit ? parseInt(limit) : 20,
    });

    res.json({
      success: true,
      results: places,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, path: '/api/search' }, 'Search error');
    res.status(500).json({
      error: 'Search failed',
    });
  }
});

/**
 * Geocode address to coordinates
 * GET /api/search/geocode?address=
 */
router.get('/geocode', async (req: Request<object, unknown, unknown, GeocodeQuery>, res: Response): Promise<void> => {
  try {
    const { address } = req.query;

    if (!address) {
      res.status(400).json({
        error: 'Address is required',
      });
      return;
    }

    const results = await searchService.geocode(address);

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, path: '/api/search/geocode' }, 'Geocode error');
    res.status(500).json({
      error: 'Geocoding failed',
    });
  }
});

/**
 * Reverse geocode coordinates to address
 * GET /api/search/reverse?lat=&lng=
 */
router.get('/reverse', async (req: Request<object, unknown, unknown, ReverseGeocodeQuery>, res: Response): Promise<void> => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      res.status(400).json({
        error: 'Latitude and longitude are required',
      });
      return;
    }

    const result = await searchService.reverseGeocode(
      parseFloat(lat),
      parseFloat(lng)
    );

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, path: '/api/search/reverse' }, 'Reverse geocode error');
    res.status(500).json({
      error: 'Reverse geocoding failed',
    });
  }
});

/**
 * Get place details
 * GET /api/search/places/:id
 */
router.get('/places/:id', async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  try {
    const place = await searchService.getPlaceDetails(req.params.id);

    if (!place) {
      res.status(404).json({
        error: 'Place not found',
      });
      return;
    }

    res.json({
      success: true,
      place,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message, placeId: req.params.id }, 'Place details error');
    res.status(500).json({
      error: 'Failed to fetch place details',
    });
  }
});

/**
 * Get available categories
 * GET /api/search/categories
 */
router.get('/categories', async (_req: Request, res: Response): Promise<void> => {
  try {
    const categories = await searchService.getCategories();

    res.json({
      success: true,
      categories,
    });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Categories error');
    res.status(500).json({
      error: 'Failed to fetch categories',
    });
  }
});

export default router;
