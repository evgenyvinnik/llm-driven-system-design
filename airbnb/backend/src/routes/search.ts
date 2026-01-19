import { Router, type Request, type Response } from 'express';
import type CircuitBreaker from 'opossum';
import { query } from '../db.js';
import { optionalAuth } from '../middleware/auth.js';
import { getCachedSearchResults, CACHE_TTL } from '../shared/cache.js';
import { metrics } from '../shared/metrics.js';
import { createModuleLogger } from '../shared/logger.js';
import { createSearchCircuitBreaker } from '../shared/circuitBreaker.js';

const router = Router();
const log = createModuleLogger('search');

// Type definitions
interface SearchParams {
  latitude?: string;
  longitude?: string;
  radius?: string | number;
  check_in?: string;
  check_out?: string;
  guests?: string | number;
  min_price?: string | number;
  max_price?: string | number;
  property_type?: string;
  room_type?: string;
  amenities?: string | string[];
  instant_book?: string;
  bedrooms?: string | number;
  beds?: string | number;
  bathrooms?: string | number;
  limit?: string | number;
  offset?: string | number;
  sort?: string;
  [key: string]: string | number | string[] | undefined;
}

interface SearchResult {
  listings: unknown[];
  total: number;
  limit: number;
  offset: number;
  fromFallback?: boolean;
}

interface ListingRow {
  id: number;
  title: string;
  description: string;
  city: string;
  state: string;
  country: string;
  property_type: string;
  room_type: string;
  max_guests: number;
  bedrooms: number;
  beds: number;
  bathrooms: number;
  amenities: string[];
  price_per_night: number;
  cleaning_fee: number;
  rating: number | null;
  review_count: number;
  instant_book: boolean;
  longitude: number;
  latitude: number;
  distance?: number;
  host_name: string;
  host_avatar: string | null;
  host_verified: boolean;
  primary_photo: string | null;
  photos: string[] | null;
}

interface SuggestionRow {
  city: string;
  state: string;
  country: string;
  longitude: number;
  latitude: number;
}

interface DestinationRow {
  city: string;
  state: string;
  country: string;
  listing_count: string;
  longitude: number;
  latitude: number;
}

// Create circuit breaker for search operations
let searchCircuitBreaker: CircuitBreaker<unknown[], SearchResult> | null = null;

const initSearchCircuitBreaker = (): CircuitBreaker<unknown[], SearchResult> => {
  if (!searchCircuitBreaker) {
    // Wrap executeSearch to match the expected signature
    const wrappedSearch = (params: unknown): Promise<SearchResult> => executeSearch(params as SearchParams);
    searchCircuitBreaker = createSearchCircuitBreaker(wrappedSearch) as CircuitBreaker<unknown[], SearchResult>;
  }
  return searchCircuitBreaker;
};

// Core search execution logic (wrapped by circuit breaker)
async function executeSearch(searchParams: SearchParams): Promise<SearchResult> {
  const {
    latitude,
    longitude,
    radius = 25000,
    check_in,
    check_out,
    guests = 1,
    min_price,
    max_price,
    property_type,
    room_type,
    amenities,
    instant_book,
    bedrooms,
    beds,
    bathrooms,
    limit = 20,
    offset = 0,
    sort = 'relevance',
  } = searchParams;

  const params: (string | number | string[])[] = [];
  const conditions: string[] = ['l.is_active = TRUE'];
  let orderBy = 'l.rating DESC NULLS LAST, l.review_count DESC';

  // Geographic filter
  if (latitude && longitude) {
    params.push(parseFloat(longitude), parseFloat(latitude), parseInt(String(radius)));
    conditions.push(`ST_DWithin(l.location, ST_MakePoint($${params.length - 2}, $${params.length - 1})::geography, $${params.length})`);
  }

  // Guest count
  params.push(parseInt(String(guests)));
  conditions.push(`l.max_guests >= $${params.length}`);

  // Price range
  if (min_price) {
    params.push(parseFloat(String(min_price)));
    conditions.push(`l.price_per_night >= $${params.length}`);
  }
  if (max_price) {
    params.push(parseFloat(String(max_price)));
    conditions.push(`l.price_per_night <= $${params.length}`);
  }

  // Property type
  if (property_type) {
    params.push(property_type);
    conditions.push(`l.property_type = $${params.length}`);
  }

  // Room type
  if (room_type) {
    params.push(room_type);
    conditions.push(`l.room_type = $${params.length}`);
  }

  // Amenities
  if (amenities) {
    const amenityList = Array.isArray(amenities) ? amenities : amenities.split(',');
    params.push(amenityList);
    conditions.push(`l.amenities @> $${params.length}`);
  }

  // Instant book
  if (instant_book === 'true') {
    conditions.push('l.instant_book = TRUE');
  }

  // Bedrooms
  if (bedrooms) {
    params.push(parseInt(String(bedrooms)));
    conditions.push(`l.bedrooms >= $${params.length}`);
  }

  // Beds
  if (beds) {
    params.push(parseInt(String(beds)));
    conditions.push(`l.beds >= $${params.length}`);
  }

  // Bathrooms
  if (bathrooms) {
    params.push(parseFloat(String(bathrooms)));
    conditions.push(`l.bathrooms >= $${params.length}`);
  }

  // Build the base query
  let sql = `
    SELECT
      l.id,
      l.title,
      l.description,
      l.city,
      l.state,
      l.country,
      l.property_type,
      l.room_type,
      l.max_guests,
      l.bedrooms,
      l.beds,
      l.bathrooms,
      l.amenities,
      l.price_per_night,
      l.cleaning_fee,
      l.rating,
      l.review_count,
      l.instant_book,
      ST_X(l.location::geometry) as longitude,
      ST_Y(l.location::geometry) as latitude,
      ${latitude && longitude ?
        `ST_Distance(l.location, ST_MakePoint($1, $2)::geography) as distance,` :
        ''}
      u.name as host_name,
      u.avatar_url as host_avatar,
      u.is_verified as host_verified,
      (SELECT url FROM listing_photos WHERE listing_id = l.id ORDER BY display_order LIMIT 1) as primary_photo,
      (SELECT array_agg(url ORDER BY display_order) FROM listing_photos WHERE listing_id = l.id) as photos
    FROM listings l
    JOIN users u ON l.host_id = u.id
    WHERE ${conditions.join(' AND ')}
  `;

  // Availability filter using date overlap check
  if (check_in && check_out) {
    const checkInParam = params.length + 1;
    const checkOutParam = params.length + 2;
    params.push(check_in, check_out);

    sql += `
      AND l.id NOT IN (
        SELECT DISTINCT listing_id
        FROM availability_blocks
        WHERE status = 'booked'
        AND (start_date, end_date) OVERLAPS ($${checkInParam}::date, $${checkOutParam}::date)
      )
      AND l.id NOT IN (
        SELECT DISTINCT listing_id
        FROM availability_blocks
        WHERE status = 'blocked'
        AND (start_date, end_date) OVERLAPS ($${checkInParam}::date, $${checkOutParam}::date)
      )
    `;
  }

  // Sorting
  if (sort === 'price_low') {
    orderBy = 'l.price_per_night ASC';
  } else if (sort === 'price_high') {
    orderBy = 'l.price_per_night DESC';
  } else if (sort === 'rating') {
    orderBy = 'l.rating DESC NULLS LAST, l.review_count DESC';
  } else if (latitude && longitude && sort === 'distance') {
    orderBy = 'distance ASC';
  }

  sql += ` ORDER BY ${orderBy}`;

  // Pagination
  params.push(parseInt(String(limit)), parseInt(String(offset)));
  sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await query<ListingRow>(sql, params);

  // Get total count for pagination
  let countSql = `
    SELECT COUNT(*) as total
    FROM listings l
    WHERE ${conditions.join(' AND ')}
  `;

  if (check_in && check_out) {
    const checkInIdx = conditions.length > 3 ? 6 : 4;
    countSql += `
      AND l.id NOT IN (
        SELECT DISTINCT listing_id
        FROM availability_blocks
        WHERE status IN ('booked', 'blocked')
        AND (start_date, end_date) OVERLAPS ($${checkInIdx}::date, $${checkInIdx + 1}::date)
      )
    `;
  }

  const countParams = params.slice(0, -2); // Remove limit and offset
  const countResult = await query<{ total: string }>(countSql, countParams);

  return {
    listings: result.rows,
    total: parseInt(countResult.rows[0]?.total || '0'),
    limit: parseInt(String(limit)),
    offset: parseInt(String(offset)),
  };
}

// Search listings with geographic filter and availability
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  const startTime = process.hrtime.bigint();
  const searchParams = req.query as SearchParams;

  const hasLocation = !!(searchParams.latitude && searchParams.longitude);
  const hasDates = !!(searchParams.check_in && searchParams.check_out);

  try {
    // Initialize circuit breaker
    const breaker = initSearchCircuitBreaker();

    // Try to get from cache first (for non-authenticated searches without dates)
    let result;
    const canCache = !hasDates && !req.user; // Don't cache date-specific or user-specific searches

    if (canCache) {
      result = await getCachedSearchResults(searchParams, async () => {
        return breaker.fire(searchParams);
      });
    } else {
      result = await breaker.fire(searchParams);
    }

    // Track metrics
    const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
    const resultCountBucket = result.listings.length === 0 ? '0' :
      result.listings.length <= 5 ? '1-5' :
      result.listings.length <= 10 ? '6-10' : '10+';

    metrics.searchLatency.observe({
      has_dates: hasDates.toString(),
      has_location: hasLocation.toString(),
      result_count_bucket: resultCountBucket,
    }, durationSeconds);
    metrics.searchesTotal.inc({
      has_dates: hasDates.toString(),
      has_location: hasLocation.toString(),
    });

    // Log if search took too long
    if (durationSeconds > 1) {
      log.warn({ durationMs: durationSeconds * 1000, searchParams }, 'Slow search query');
    }

    // Check if result is from fallback (circuit breaker open)
    if (result.fromFallback) {
      log.warn({ searchParams }, 'Search returned fallback result (circuit breaker open)');
    }

    res.json(result);
  } catch (error) {
    log.error({ error, searchParams }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

// Suggest locations based on search term
router.get('/suggest', async (req: Request, res: Response) => {
  const { q } = req.query;

  if (!q || (typeof q === 'string' && q.length < 2)) {
    return res.json({ suggestions: [] });
  }

  try {
    const result = await query<SuggestionRow>(
      `SELECT DISTINCT city, state, country,
        ST_X(location::geometry) as longitude,
        ST_Y(location::geometry) as latitude
      FROM listings
      WHERE is_active = TRUE
        AND (city ILIKE $1 OR state ILIKE $1 OR country ILIKE $1)
      LIMIT 10`,
      [`%${q}%`]
    );

    const suggestions = result.rows.map((row) => ({
      label: [row.city, row.state, row.country].filter(Boolean).join(', '),
      city: row.city,
      state: row.state,
      country: row.country,
      latitude: row.latitude,
      longitude: row.longitude,
    }));

    res.json({ suggestions });
  } catch (error) {
    log.error({ error, query: q }, 'Suggest error');
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Get popular destinations
router.get('/popular-destinations', async (_req: Request, res: Response) => {
  try {
    const result = await query<DestinationRow>(
      `SELECT
        city,
        state,
        country,
        COUNT(*) as listing_count,
        AVG(ST_X(location::geometry)) as longitude,
        AVG(ST_Y(location::geometry)) as latitude
      FROM listings
      WHERE is_active = TRUE AND city IS NOT NULL
      GROUP BY city, state, country
      ORDER BY listing_count DESC
      LIMIT 10`
    );

    res.json({ destinations: result.rows });
  } catch (error) {
    log.error({ error }, 'Popular destinations error');
    res.status(500).json({ error: 'Failed to fetch destinations' });
  }
});

export default router;
