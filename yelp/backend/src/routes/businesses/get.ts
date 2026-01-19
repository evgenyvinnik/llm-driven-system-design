/**
 * Business retrieval route handlers.
 * @module routes/businesses/get
 */
import { Router, Request, Response } from 'express';
import { pool } from '../../utils/db.js';
import { cache } from '../../utils/redis.js';
import { optionalAuth, AuthenticatedRequest } from '../../middleware/auth.js';
import { BusinessRow, BusinessHour, BusinessPhoto, CountRow } from './types.js';

/**
 * Express router for business retrieval endpoints.
 */
export const router = Router();

/**
 * Lists all businesses with pagination and optional filtering.
 *
 * @description
 * Retrieves a paginated list of businesses with support for filtering by city,
 * category, and minimum rating. Results are sorted by rating and review count.
 * Each business includes its categories and primary photo URL.
 *
 * @route GET /
 *
 * @param req.query.page - Page number (default: 1)
 * @param req.query.limit - Results per page (default: 20)
 * @param req.query.city - Filter by city name (case-insensitive)
 * @param req.query.category - Filter by category slug
 * @param req.query.minRating - Minimum rating threshold
 *
 * @returns {Object} JSON object with businesses and pagination info
 * @returns {BusinessRow[]} response.businesses - Array of business objects
 * @returns {Object} response.pagination - Pagination metadata
 * @returns {number} response.pagination.page - Current page number
 * @returns {number} response.pagination.limit - Results per page
 * @returns {number} response.pagination.total - Total number of businesses
 * @returns {number} response.pagination.pages - Total number of pages
 *
 * @throws {500} Database or server error
 *
 * @example
 * // GET /businesses?city=San%20Francisco&category=restaurants&minRating=4&page=1&limit=10
 */
router.get(
  '/',
  async (req: Request, res: Response): Promise<void | Response> => {
    try {
      const {
        page = '1',
        limit = '20',
        city,
        category,
        minRating,
      } = req.query as {
        page?: string;
        limit?: string;
        city?: string;
        category?: string;
        minRating?: string;
      };
      const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

      let query = `
      SELECT b.*,
             array_agg(DISTINCT c.slug) FILTER (WHERE c.slug IS NOT NULL) as categories,
             array_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL) as category_names,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as photo_url
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      WHERE 1=1
    `;

      const params: unknown[] = [];
      let paramIndex = 1;

      if (city) {
        query += ` AND LOWER(b.city) = LOWER($${paramIndex++})`;
        params.push(city);
      }

      if (category) {
        query += ` AND c.slug = $${paramIndex++}`;
        params.push(category);
      }

      if (minRating) {
        query += ` AND b.rating >= $${paramIndex++}`;
        params.push(parseFloat(minRating));
      }

      query += ` GROUP BY b.id ORDER BY b.rating DESC, b.review_count DESC`;
      query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      params.push(parseInt(limit, 10), offset);

      const result = await pool.query<BusinessRow>(query, params);

      // Get total count
      let countQuery = `
      SELECT COUNT(DISTINCT b.id)
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      WHERE 1=1
    `;
      const countParams: unknown[] = [];
      let countParamIndex = 1;

      if (city) {
        countQuery += ` AND LOWER(b.city) = LOWER($${countParamIndex++})`;
        countParams.push(city);
      }
      if (category) {
        countQuery += ` AND c.slug = $${countParamIndex++}`;
        countParams.push(category);
      }
      if (minRating) {
        countQuery += ` AND b.rating >= $${countParamIndex++}`;
        countParams.push(parseFloat(minRating));
      }

      const countResult = await pool.query<CountRow>(countQuery, countParams);

      res.json({
        businesses: result.rows,
        pagination: {
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
          total: parseInt(countResult.rows[0].count, 10),
          pages: Math.ceil(
            parseInt(countResult.rows[0].count, 10) / parseInt(limit, 10)
          ),
        },
      });
    } catch (error) {
      console.error('Get businesses error:', error);
      res.status(500).json({ error: { message: 'Failed to fetch businesses' } });
    }
  }
);

/**
 * Retrieves a single business by ID or slug.
 *
 * @description
 * Fetches detailed business information including categories, hours, photos,
 * and owner name. Uses Redis caching with a 5-minute TTL for improved performance.
 * Supports both UUID-based lookups and human-readable slug lookups.
 * If the user is authenticated, includes an `is_owner` flag.
 *
 * @route GET /:idOrSlug
 *
 * @param req.params.idOrSlug - Business UUID or URL-friendly slug
 *
 * @returns {Object} JSON object containing the business
 * @returns {BusinessRow} response.business - The business with full details
 * @returns {BusinessHour[]} response.business.hours - Operating hours by day
 * @returns {BusinessPhoto[]} response.business.photos - Business photos
 * @returns {string} response.business.owner_name - Owner's display name
 * @returns {boolean} response.business.is_owner - True if current user is owner
 *
 * @throws {404} Business not found
 * @throws {500} Database or server error
 *
 * @example
 * // GET /businesses/joes-coffee-shop
 * // GET /businesses/550e8400-e29b-41d4-a716-446655440000
 */
router.get(
  '/:idOrSlug',
  optionalAuth as any,
  async (req: AuthenticatedRequest, res: Response): Promise<void | Response> => {
    try {
      const idOrSlug = req.params.idOrSlug;
      const identifier = Array.isArray(idOrSlug) ? idOrSlug[0] : idOrSlug;
      const cacheKey = `business:${identifier}`;

      // Try cache first
      const cached = await cache.get<BusinessRow>(cacheKey);
      if (cached) {
        return res.json({ business: cached });
      }

      // Check if it's a UUID or slug
      const isUUID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          identifier
        );

      const query = `
      SELECT b.*,
             array_agg(DISTINCT jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug)) FILTER (WHERE c.id IS NOT NULL) as categories,
             u.name as owner_name
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      LEFT JOIN users u ON b.owner_id = u.id
      WHERE ${isUUID ? 'b.id = $1' : 'b.slug = $1'}
      GROUP BY b.id, u.name
    `;

      const result = await pool.query<BusinessRow>(query, [identifier]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: { message: 'Business not found' } });
      }

      const business = result.rows[0];

      // Get business hours
      const hoursResult = await pool.query<BusinessHour>(
        'SELECT day_of_week, open_time, close_time, is_closed FROM business_hours WHERE business_id = $1 ORDER BY day_of_week',
        [business.id]
      );
      business.hours = hoursResult.rows;

      // Get photos
      const photosResult = await pool.query<BusinessPhoto>(
        'SELECT id, url, caption, is_primary FROM business_photos WHERE business_id = $1 ORDER BY is_primary DESC, created_at DESC',
        [business.id]
      );
      business.photos = photosResult.rows;

      // Check if current user is owner
      if (req.user) {
        business.is_owner = req.user.id === business.owner_id;
      }

      // Cache for 5 minutes
      await cache.set(cacheKey, business, 300);

      res.json({ business });
    } catch (error) {
      console.error('Get business error:', error);
      res.status(500).json({ error: { message: 'Failed to fetch business' } });
    }
  }
);
