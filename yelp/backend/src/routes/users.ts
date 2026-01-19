import { Router, Request, Response } from 'express';
import { pool } from '../utils/db.js';
import { authenticate, optionalAuth, AuthenticatedRequest, AuthUser } from '../middleware/auth.js';

const router = Router();

// User profile interface
interface UserProfile {
  id: string;
  name: string;
  avatar_url: string | null;
  review_count: number;
  created_at: string;
  recent_reviews?: ReviewWithBusiness[];
}

// Review with business info
interface ReviewWithBusiness {
  id: string;
  business_id: string;
  user_id: string;
  rating: number;
  text: string;
  created_at: string;
  business_name: string;
  business_slug: string;
  business_city: string;
  business_photo?: string | null;
  business_rating?: number;
  photos?: string[] | null;
}

// Business row
interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  rating: number;
  review_count: number;
  category_names: string[] | null;
  photo_url: string | null;
  created_at: string;
}

// Get user profile
router.get(
  '/:id',
  optionalAuth as any,
  async (req: AuthenticatedRequest, res: Response): Promise<void | Response> => {
    try {
      const { id } = req.params;

      const result = await pool.query<UserProfile>(
        `
      SELECT id, name, avatar_url, review_count, created_at
      FROM users
      WHERE id = $1
    `,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: { message: 'User not found' } });
      }

      const user: UserProfile = result.rows[0];

      // Get user's reviews
      const reviewsResult = await pool.query<ReviewWithBusiness>(
        `
      SELECT r.*,
             b.name as business_name, b.slug as business_slug, b.city as business_city,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as business_photo
      FROM reviews r
      JOIN businesses b ON r.business_id = b.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 10
    `,
        [id]
      );

      user.recent_reviews = reviewsResult.rows;

      res.json({ user });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ error: { message: 'Failed to fetch user' } });
    }
  }
);

// Get user's reviews
router.get('/:id/reviews', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { page = '1', limit = '10' } = req.query as {
      page?: string;
      limit?: string;
    };
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const result = await pool.query<ReviewWithBusiness>(
      `
      SELECT r.*,
             b.name as business_name, b.slug as business_slug, b.city as business_city,
             b.rating as business_rating,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as business_photo,
             array_agg(DISTINCT rp.url) FILTER (WHERE rp.url IS NOT NULL) as photos
      FROM reviews r
      JOIN businesses b ON r.business_id = b.id
      LEFT JOIN review_photos rp ON r.id = rp.review_id
      WHERE r.user_id = $1
      GROUP BY r.id, b.name, b.slug, b.city, b.rating
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `,
      [id, parseInt(limit, 10), offset]
    );

    const countResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) FROM reviews WHERE user_id = $1',
      [id]
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
    console.error('Get user reviews error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch reviews' } });
  }
});

// Get user's businesses (for business owners)
router.get(
  '/:id/businesses',
  authenticate as any,
  async (req: AuthenticatedRequest, res: Response): Promise<void | Response> => {
    try {
      const { id } = req.params;

      // Only allow user to see their own businesses or admin
      if (req.user!.id !== id && req.user!.role !== 'admin') {
        return res.status(403).json({ error: { message: 'Not authorized' } });
      }

      const result = await pool.query<BusinessRow>(
        `
      SELECT b.*,
             array_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL) as category_names,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as photo_url
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      WHERE b.owner_id = $1
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `,
        [id]
      );

      res.json({ businesses: result.rows });
    } catch (error) {
      console.error('Get user businesses error:', error);
      res.status(500).json({ error: { message: 'Failed to fetch businesses' } });
    }
  }
);

export default router;
