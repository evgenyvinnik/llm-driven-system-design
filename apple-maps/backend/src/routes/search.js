import { Router } from 'express';
import searchService from '../services/searchService.js';

const router = Router();

/**
 * Search for places
 * GET /api/search?q=&lat=&lng=&radius=&category=&limit=
 */
router.get('/', async (req, res) => {
  try {
    const { q, lat, lng, radius, category, limit } = req.query;

    if (!q && !category && !lat) {
      return res.status(400).json({
        error: 'Search query (q), category, or location required',
      });
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
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Search failed',
    });
  }
});

/**
 * Geocode address to coordinates
 * GET /api/search/geocode?address=
 */
router.get('/geocode', async (req, res) => {
  try {
    const { address } = req.query;

    if (!address) {
      return res.status(400).json({
        error: 'Address is required',
      });
    }

    const results = await searchService.geocode(address);

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    console.error('Geocode error:', error);
    res.status(500).json({
      error: 'Geocoding failed',
    });
  }
});

/**
 * Reverse geocode coordinates to address
 * GET /api/search/reverse?lat=&lng=
 */
router.get('/reverse', async (req, res) => {
  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        error: 'Latitude and longitude are required',
      });
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
    console.error('Reverse geocode error:', error);
    res.status(500).json({
      error: 'Reverse geocoding failed',
    });
  }
});

/**
 * Get place details
 * GET /api/search/places/:id
 */
router.get('/places/:id', async (req, res) => {
  try {
    const place = await searchService.getPlaceDetails(req.params.id);

    if (!place) {
      return res.status(404).json({
        error: 'Place not found',
      });
    }

    res.json({
      success: true,
      place,
    });
  } catch (error) {
    console.error('Place details error:', error);
    res.status(500).json({
      error: 'Failed to fetch place details',
    });
  }
});

/**
 * Get available categories
 * GET /api/search/categories
 */
router.get('/categories', async (req, res) => {
  try {
    const categories = await searchService.getCategories();

    res.json({
      success: true,
      categories,
    });
  } catch (error) {
    console.error('Categories error:', error);
    res.status(500).json({
      error: 'Failed to fetch categories',
    });
  }
});

export default router;
