import { Router, Request, Response } from 'express';
import {
  searchBusinesses,
  autocompleteBusiness,
  SearchOptions,
  SearchResult,
  AutocompleteResult,
} from '../utils/elasticsearch.js';
import { cache, redis } from '../utils/redis.js';
import { logger, logSearch, logCacheOperation } from '../utils/logger.js';
import { recordSearch, recordCacheOperation } from '../utils/metrics.js';
import { createCircuitBreaker, setFallback } from '../utils/circuitBreaker.js';
import { pool } from '../utils/db.js';

const router = Router();

// Search response interface
interface SearchResponse {
  businesses: SearchResult['businesses'];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
  filters: Record<string, string | number | undefined>;
  meta: {
    took_ms: number;
    cache_hit: boolean;
    fallback: boolean;
  };
}

// Popular search item interface
interface PopularSearchItem {
  name: string;
  slug: string;
  icon: string;
}

// ============================================================================
// Circuit Breakers for Search Operations
// ============================================================================

// Elasticsearch search circuit breaker
const esSearchBreaker = createCircuitBreaker(
  'elasticsearch_search',
  searchBusinesses,
  {
    timeout: 3000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
  }
);

// Fallback: PostgreSQL full-text search when Elasticsearch is down
setFallback(esSearchBreaker, async (options: SearchOptions): Promise<SearchResult> => {
  logger.warn({ component: 'search' }, 'Using PostgreSQL fallback for search');

  const {
    query,
    category,
    latitude,
    longitude,
    distance,
    minRating,
    from = 0,
    size = 20,
  } = options;

  let sql = `
    SELECT b.*,
           array_agg(DISTINCT c.slug) FILTER (WHERE c.slug IS NOT NULL) as categories
    FROM businesses b
    LEFT JOIN business_categories bc ON b.id = bc.business_id
    LEFT JOIN categories c ON bc.category_id = c.id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  let paramIndex = 1;

  if (query) {
    sql += ` AND (b.name ILIKE $${paramIndex} OR b.description ILIKE $${paramIndex})`;
    params.push(`%${query}%`);
    paramIndex++;
  }

  if (category) {
    sql += ` AND c.slug = $${paramIndex}`;
    params.push(category);
    paramIndex++;
  }

  if (latitude && longitude && distance) {
    const distanceKm =
      parseInt(String(distance).replace('km', ''), 10) || 10;
    sql += ` AND ST_DWithin(b.location::geography, ST_SetSRID(ST_MakePoint($${paramIndex}, $${paramIndex + 1}), 4326)::geography, $${paramIndex + 2})`;
    params.push(
      parseFloat(String(longitude)),
      parseFloat(String(latitude)),
      distanceKm * 1000
    );
    paramIndex += 3;
  }

  if (minRating) {
    sql += ` AND b.rating >= $${paramIndex}`;
    params.push(parseFloat(String(minRating)));
    paramIndex++;
  }

  sql += ` GROUP BY b.id ORDER BY b.rating DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  params.push(size, from);

  const result = await pool.query(sql, params);

  return {
    total: result.rows.length,
    businesses: result.rows.map((b) => ({
      ...b,
      score: null, // No relevance score from PostgreSQL
    })),
    fallback: true,
  };
});

// Autocomplete circuit breaker
const esAutocompleteBreaker = createCircuitBreaker(
  'elasticsearch_autocomplete',
  autocompleteBusiness,
  {
    timeout: 2000,
    errorThresholdPercentage: 60,
    resetTimeout: 20000,
  }
);

// Fallback: Simple prefix search in PostgreSQL
setFallback(
  esAutocompleteBreaker,
  async (
    prefix: string,
    _latitude?: number | null,
    _longitude?: number | null
  ): Promise<AutocompleteResult[]> => {
    logger.warn(
      { component: 'search' },
      'Using PostgreSQL fallback for autocomplete'
    );

    const result = await pool.query<AutocompleteResult>(
      `SELECT id, name, city, rating
     FROM businesses
     WHERE name ILIKE $1
     ORDER BY rating DESC
     LIMIT 10`,
      [`${prefix}%`]
    );

    return result.rows;
  }
);

// ============================================================================
// Main Search Endpoint
// ============================================================================
router.get('/', async (req: Request, res: Response): Promise<void | Response> => {
  const startTime = Date.now();

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
      page = '1',
      limit = '20',
    } = req.query as {
      q?: string;
      category?: string;
      latitude?: string;
      longitude?: string;
      distance?: string;
      minRating?: string;
      maxPriceLevel?: string;
      sortBy?: string;
      page?: string;
      limit?: string;
    };

    const from = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    // Create cache key from query params
    const cacheKey = `search:${JSON.stringify({
      query,
      category,
      latitude,
      longitude,
      distance,
      minRating,
      maxPriceLevel,
      sortBy,
      from,
      limit,
    })}`;

    // Try cache first (short TTL for search results)
    const cached = await cache.get<SearchResponse>(cacheKey);
    if (cached) {
      const duration = Date.now() - startTime;

      // Log and record metrics
      logCacheOperation('get', cacheKey, true);
      recordCacheOperation('get', true);
      recordSearch(
        true,
        !!latitude,
        !!category,
        cached.businesses.length,
        duration / 1000
      );
      logSearch(query, cached.businesses.length, duration, {
        cache_hit: true,
        category,
        has_geo: !!latitude,
      });

      return res.json({ ...cached, meta: { ...cached.meta, cache_hit: true } });
    }

    recordCacheOperation('get', false);

    // Execute search through circuit breaker
    const results = (await esSearchBreaker.fire({
      query,
      category,
      latitude,
      longitude,
      distance,
      minRating,
      maxPriceLevel,
      sortBy: sortBy as SearchOptions['sortBy'],
      from,
      size: parseInt(limit, 10),
    })) as SearchResult;

    const response: SearchResponse = {
      businesses: results.businesses,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total: results.total,
        pages: Math.ceil(results.total / parseInt(limit, 10)),
      },
      filters: {
        query,
        category,
        latitude,
        longitude,
        distance,
        minRating,
        maxPriceLevel,
        sortBy,
      },
      meta: {
        took_ms: Date.now() - startTime,
        cache_hit: false,
        fallback: results.fallback || false,
      },
    };

    // Cache for 2 minutes (only if not a fallback result)
    if (!results.fallback) {
      await cache.set(cacheKey, response, 120);
    }

    const duration = Date.now() - startTime;
    recordSearch(
      false,
      !!latitude,
      !!category,
      results.businesses.length,
      duration / 1000
    );
    logSearch(query, results.businesses.length, duration, {
      cache_hit: false,
      category,
      has_geo: !!latitude,
      fallback: results.fallback || false,
    });

    res.json(response);
  } catch (error) {
    logger.error(
      { component: 'search', error: (error as Error).message },
      'Search error'
    );
    res.status(500).json({ error: { message: 'Search failed' } });
  }
});

// ============================================================================
// Autocomplete Endpoint
// ============================================================================
router.get(
  '/autocomplete',
  async (req: Request, res: Response): Promise<void | Response> => {
    try {
      const { q: prefix, latitude, longitude } = req.query as {
        q?: string;
        latitude?: string;
        longitude?: string;
      };

      if (!prefix || prefix.length < 2) {
        return res.json({ suggestions: [] });
      }

      const cacheKey = `autocomplete:${prefix.toLowerCase()}`;
      const cached = await cache.get<AutocompleteResult[]>(cacheKey);
      if (cached) {
        recordCacheOperation('get', true);
        return res.json({ suggestions: cached });
      }

      recordCacheOperation('get', false);

      const suggestions = (await esAutocompleteBreaker.fire(
        prefix,
        latitude ? parseFloat(latitude) : null,
        longitude ? parseFloat(longitude) : null
      )) as AutocompleteResult[];

      // Cache for 5 minutes
      await cache.set(cacheKey, suggestions, 300);

      res.json({ suggestions });
    } catch (error) {
      logger.error(
        { component: 'search', error: (error as Error).message },
        'Autocomplete error'
      );
      res.status(500).json({ error: { message: 'Autocomplete failed' } });
    }
  }
);

// ============================================================================
// Popular Searches by Location
// ============================================================================
router.get(
  '/popular',
  async (req: Request, res: Response): Promise<void | Response> => {
    try {
      const { _latitude, _longitude } = req.query as {
        latitude?: string;
        longitude?: string;
      };

      // Try to get popular searches from Redis sorted set
      const cacheKey = 'popular:searches';
      const cachedPopular = await redis.zrevrange(cacheKey, 0, 9, 'WITHSCORES');

      if (cachedPopular.length > 0) {
        // Convert to array of {term, count}
        const popular: Array<{ term: string; count: number }> = [];
        for (let i = 0; i < cachedPopular.length; i += 2) {
          popular.push({
            term: cachedPopular[i],
            count: parseInt(cachedPopular[i + 1], 10),
          });
        }
        return res.json({ popular });
      }

      // Return static popular categories if no data
      const popular: PopularSearchItem[] = [
        { name: 'Restaurants', slug: 'restaurants', icon: 'utensils' },
        { name: 'Coffee', slug: 'coffee-tea', icon: 'coffee' },
        { name: 'Bars', slug: 'bars', icon: 'beer' },
        { name: 'Pizza', slug: 'pizza', icon: 'pizza' },
        { name: 'Mexican', slug: 'mexican', icon: 'taco' },
        { name: 'Japanese', slug: 'japanese', icon: 'sushi' },
      ];

      res.json({ popular });
    } catch (error) {
      logger.error(
        { component: 'search', error: (error as Error).message },
        'Popular search error'
      );
      res
        .status(500)
        .json({ error: { message: 'Failed to get popular searches' } });
    }
  }
);

// ============================================================================
// Track Search Query for Analytics
// ============================================================================
router.post('/track', async (req: Request, res: Response): Promise<void> => {
  try {
    const { query } = req.body as { query?: string };

    if (query && query.length >= 2) {
      // Increment query count in sorted set
      await redis.zincrby('popular:searches', 1, query.toLowerCase().trim());

      // Set TTL on the sorted set (1 hour)
      await redis.expire('popular:searches', 3600);
    }

    res.json({ tracked: true });
  } catch (error) {
    logger.error(
      { component: 'search', error: (error as Error).message },
      'Track query error'
    );
    res.status(500).json({ error: { message: 'Failed to track query' } });
  }
});

export default router;
