import { Router } from 'express';
import { pool } from '../utils/db.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Get user profile
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT id, name, avatar_url, review_count, created_at
      FROM users
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    const user = result.rows[0];

    // Get user's reviews
    const reviewsResult = await pool.query(`
      SELECT r.*,
             b.name as business_name, b.slug as business_slug, b.city as business_city,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as business_photo
      FROM reviews r
      JOIN businesses b ON r.business_id = b.id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 10
    `, [id]);

    user.recent_reviews = reviewsResult.rows;

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch user' } });
  }
});

// Get user's reviews
router.get('/:id/reviews', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await pool.query(`
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
    `, [id, parseInt(limit), parseInt(offset)]);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM reviews WHERE user_id = $1',
      [id]
    );

    res.json({
      reviews: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get user reviews error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch reviews' } });
  }
});

// Get user's businesses (for business owners)
router.get('/:id/businesses', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Only allow user to see their own businesses or admin
    if (req.user.id !== id && req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Not authorized' } });
    }

    const result = await pool.query(`
      SELECT b.*,
             array_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL) as category_names,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as photo_url
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      WHERE b.owner_id = $1
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `, [id]);

    res.json({ businesses: result.rows });
  } catch (error) {
    console.error('Get user businesses error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch businesses' } });
  }
});

export default router;
