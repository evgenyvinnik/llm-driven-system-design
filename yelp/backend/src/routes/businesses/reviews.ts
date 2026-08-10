/**
 * Business reviews route handler.
 * @module routes/businesses/reviews
 */
import { Router, Request, Response } from 'express';
import { pool } from '../../utils/db.js';
import { ReviewWithUser, CountRow } from './types.js';

/**
 * Express router for business review endpoints.
 */
export const router = Router();

/** Matches a canonical UUID, used to tell an ID apart from a slug. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a business identifier that may be either a UUID or a slug.
 *
 * `GET /businesses/:idOrSlug` accepts both, and the frontend routes business
 * pages by slug — but the review endpoints passed the raw parameter straight
 * into `WHERE business_id = $1`, so every slug-based page load failed with
 * "invalid input syntax for type uuid" and reviews silently never rendered.
 *
 * @param idOrSlug - Business UUID or URL slug
 * @returns The business UUID, or null when no business matches
 */
async function resolveBusinessId(idOrSlug: string): Promise<string | null> {
  if (UUID_PATTERN.test(idOrSlug)) return idOrSlug;
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM businesses WHERE slug = $1',
    [idOrSlug]
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Retrieves reviews for a specific business.
 *
 * @description
 * Fetches a paginated list of reviews for the specified business.
 * Each review includes the reviewer's profile information, any photos
 * attached to the review, and the business owner's response if present.
 * Supports multiple sorting options.
 *
 * @route GET /:id/reviews
 *
 * @param req.params.id - Business UUID or slug
 * @param req.query.page - Page number (default: 1)
 * @param req.query.limit - Results per page (default: 10)
 * @param req.query.sort - Sort order: 'recent' (default), 'rating_high', 'rating_low', or 'helpful'
 *
 * @returns {Object} JSON object with reviews and pagination info
 * @returns {ReviewWithUser[]} response.reviews - Array of reviews with user info
 * @returns {string} response.reviews[].user_name - Reviewer's display name
 * @returns {string} response.reviews[].user_avatar - Reviewer's avatar URL
 * @returns {number} response.reviews[].user_review_count - Total reviews by this user
 * @returns {string} response.reviews[].response_text - Owner's response text (if any)
 * @returns {string[]} response.reviews[].photos - Array of photo URLs attached to review
 * @returns {Object} response.pagination - Pagination metadata
 * @returns {number} response.pagination.page - Current page number
 * @returns {number} response.pagination.limit - Results per page
 * @returns {number} response.pagination.total - Total number of reviews
 * @returns {number} response.pagination.pages - Total number of pages
 *
 * @throws {500} Database or server error
 *
 * @example
 * // GET /businesses/550e8400-e29b-41d4-a716-446655440000/reviews?sort=helpful&page=1&limit=5
 */
router.get(
  '/:id/reviews',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const businessId = await resolveBusinessId(String(req.params.id));
      if (!businessId) {
        res.status(404).json({ error: { message: 'Business not found' } });
        return;
      }
      const {
        page = '1',
        limit = '10',
        sort = 'recent',
      } = req.query as {
        page?: string;
        limit?: string;
        sort?: string;
      };
      const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

      let orderBy = 'r.created_at DESC';
      if (sort === 'rating_high') orderBy = 'r.rating DESC, r.created_at DESC';
      if (sort === 'rating_low') orderBy = 'r.rating ASC, r.created_at DESC';
      if (sort === 'helpful') orderBy = 'r.helpful_count DESC, r.created_at DESC';

      const query = `
      SELECT r.*,
             u.name as user_name, u.avatar_url as user_avatar, u.review_count as user_review_count,
             rr.text as response_text, rr.created_at as response_created_at,
             array_agg(DISTINCT rp.url) FILTER (WHERE rp.url IS NOT NULL) as photos
      FROM reviews r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN review_responses rr ON r.id = rr.review_id
      LEFT JOIN review_photos rp ON r.id = rp.review_id
      WHERE r.business_id = $1
      GROUP BY r.id, u.name, u.avatar_url, u.review_count, rr.text, rr.created_at
      ORDER BY ${orderBy}
      LIMIT $2 OFFSET $3
    `;

      const result = await pool.query<ReviewWithUser>(query, [
        businessId,
        parseInt(limit, 10),
        offset,
      ]);

      const countResult = await pool.query<CountRow>(
        'SELECT COUNT(*) FROM reviews WHERE business_id = $1',
        [businessId]
      );

      res.json({
        reviews: result.rows,
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
      console.error('Get reviews error:', error);
      res.status(500).json({ error: { message: 'Failed to fetch reviews' } });
    }
  }
);
