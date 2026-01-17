import { Router } from 'express';
import { searchBusinesses, autocompleteBusiness } from '../utils/elasticsearch.js';
import { cache } from '../utils/redis.js';

const router = Router();

// Main search endpoint
router.get('/', async (req, res) => {
  try {
    const {
      q: query,
      category,
      latitude,
      longitude,
      distance,
      minRating,
      maxPriceLevel,
      sortBy,
      page = 1,
      limit = 20
    } = req.query;

    const from = (parseInt(page) - 1) * parseInt(limit);

    // Create cache key from query params
    const cacheKey = `search:${JSON.stringify({
      query, category, latitude, longitude, distance, minRating, maxPriceLevel, sortBy, from, limit
    })}`;

    // Try cache first (short TTL for search results)
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const results = await searchBusinesses({
      query,
      category,
      latitude,
      longitude,
      distance,
      minRating,
      maxPriceLevel,
      sortBy,
      from,
      size: parseInt(limit)
    });

    const response = {
      businesses: results.businesses,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: results.total,
        pages: Math.ceil(results.total / parseInt(limit))
      },
      filters: {
        query,
        category,
        latitude,
        longitude,
        distance,
        minRating,
        maxPriceLevel,
        sortBy
      }
    };

    // Cache for 2 minutes
    await cache.set(cacheKey, response, 120);

    res.json(response);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: { message: 'Search failed' } });
  }
});

// Autocomplete endpoint
router.get('/autocomplete', async (req, res) => {
  try {
    const { q: prefix, latitude, longitude } = req.query;

    if (!prefix || prefix.length < 2) {
      return res.json({ suggestions: [] });
    }

    const cacheKey = `autocomplete:${prefix.toLowerCase()}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ suggestions: cached });
    }

    const suggestions = await autocompleteBusiness(
      prefix,
      latitude ? parseFloat(latitude) : null,
      longitude ? parseFloat(longitude) : null
    );

    // Cache for 5 minutes
    await cache.set(cacheKey, suggestions, 300);

    res.json({ suggestions });
  } catch (error) {
    console.error('Autocomplete error:', error);
    res.status(500).json({ error: { message: 'Autocomplete failed' } });
  }
});

// Popular searches by location
router.get('/popular', async (req, res) => {
  try {
    const { latitude, longitude } = req.query;

    // Return static popular categories for now
    const popular = [
      { name: 'Restaurants', slug: 'restaurants', icon: 'utensils' },
      { name: 'Coffee', slug: 'coffee-tea', icon: 'coffee' },
      { name: 'Bars', slug: 'bars', icon: 'beer' },
      { name: 'Pizza', slug: 'pizza', icon: 'pizza' },
      { name: 'Mexican', slug: 'mexican', icon: 'taco' },
      { name: 'Japanese', slug: 'japanese', icon: 'sushi' }
    ];

    res.json({ popular });
  } catch (error) {
    console.error('Popular search error:', error);
    res.status(500).json({ error: { message: 'Failed to get popular searches' } });
  }
});

export default router;
