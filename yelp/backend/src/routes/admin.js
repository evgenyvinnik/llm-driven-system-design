import { Router } from 'express';
import { pool } from '../utils/db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { cache } from '../utils/redis.js';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireAdmin);

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const cacheKey = 'admin:stats';
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const stats = {};

    // Total counts
    const usersResult = await pool.query('SELECT COUNT(*) FROM users');
    stats.total_users = parseInt(usersResult.rows[0].count);

    const businessesResult = await pool.query('SELECT COUNT(*) FROM businesses');
    stats.total_businesses = parseInt(businessesResult.rows[0].count);

    const reviewsResult = await pool.query('SELECT COUNT(*) FROM reviews');
    stats.total_reviews = parseInt(reviewsResult.rows[0].count);

    // Claimed vs unclaimed businesses
    const claimedResult = await pool.query('SELECT COUNT(*) FROM businesses WHERE is_claimed = true');
    stats.claimed_businesses = parseInt(claimedResult.rows[0].count);
    stats.unclaimed_businesses = stats.total_businesses - stats.claimed_businesses;

    // Reviews in last 24 hours
    const recentReviewsResult = await pool.query(
      "SELECT COUNT(*) FROM reviews WHERE created_at > NOW() - INTERVAL '24 hours'"
    );
    stats.reviews_last_24h = parseInt(recentReviewsResult.rows[0].count);

    // New users in last 7 days
    const newUsersResult = await pool.query(
      "SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'"
    );
    stats.new_users_last_7d = parseInt(newUsersResult.rows[0].count);

    // Average rating across all businesses
    const avgRatingResult = await pool.query(
      'SELECT AVG(rating) as avg_rating FROM businesses WHERE review_count > 0'
    );
    stats.average_rating = parseFloat(avgRatingResult.rows[0].avg_rating || 0).toFixed(2);

    // Top cities by business count
    const topCitiesResult = await pool.query(`
      SELECT city, state, COUNT(*) as count
      FROM businesses
      GROUP BY city, state
      ORDER BY count DESC
      LIMIT 5
    `);
    stats.top_cities = topCitiesResult.rows;

    // Cache for 5 minutes
    await cache.set(cacheKey, stats, 300);

    res.json(stats);
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch stats' } });
  }
});

// List all users
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, role, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT id, email, name, avatar_url, role, review_count, created_at, updated_at
      FROM users
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (role) {
      query += ` AND role = $${paramIndex++}`;
      params.push(role);
    }

    if (search) {
      query += ` AND (LOWER(name) LIKE $${paramIndex} OR LOWER(email) LIKE $${paramIndex++})`;
      params.push(`%${search.toLowerCase()}%`);
    }

    query += ` ORDER BY created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM users WHERE 1=1';
    const countParams = [];
    let countParamIndex = 1;

    if (role) {
      countQuery += ` AND role = $${countParamIndex++}`;
      countParams.push(role);
    }
    if (search) {
      countQuery += ` AND (LOWER(name) LIKE $${countParamIndex} OR LOWER(email) LIKE $${countParamIndex++})`;
      countParams.push(`%${search.toLowerCase()}%`);
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      users: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch users' } });
  }
});

// Update user role
router.patch('/users/:id/role', async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['user', 'business_owner', 'admin'].includes(role)) {
      return res.status(400).json({ error: { message: 'Invalid role' } });
    }

    const result = await pool.query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, role',
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: { message: 'Failed to update role' } });
  }
});

// List all businesses with admin filters
router.get('/businesses', async (req, res) => {
  try {
    const { page = 1, limit = 20, claimed, verified, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT b.*, u.name as owner_name, u.email as owner_email
      FROM businesses b
      LEFT JOIN users u ON b.owner_id = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (claimed !== undefined) {
      query += ` AND b.is_claimed = $${paramIndex++}`;
      params.push(claimed === 'true');
    }

    if (verified !== undefined) {
      query += ` AND b.is_verified = $${paramIndex++}`;
      params.push(verified === 'true');
    }

    if (search) {
      query += ` AND LOWER(b.name) LIKE $${paramIndex++}`;
      params.push(`%${search.toLowerCase()}%`);
    }

    query += ` ORDER BY b.created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM businesses WHERE 1=1';
    const countParams = [];
    let countParamIndex = 1;

    if (claimed !== undefined) {
      countQuery += ` AND is_claimed = $${countParamIndex++}`;
      countParams.push(claimed === 'true');
    }
    if (verified !== undefined) {
      countQuery += ` AND is_verified = $${countParamIndex++}`;
      countParams.push(verified === 'true');
    }
    if (search) {
      countQuery += ` AND LOWER(name) LIKE $${countParamIndex++}`;
      countParams.push(`%${search.toLowerCase()}%`);
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      businesses: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('List businesses error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch businesses' } });
  }
});

// Verify a business
router.patch('/businesses/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const { verified } = req.body;

    const result = await pool.query(
      'UPDATE businesses SET is_verified = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [verified !== false, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Business not found' } });
    }

    // Clear cache
    await cache.delPattern(`business:${id}*`);

    res.json({ business: result.rows[0] });
  } catch (error) {
    console.error('Verify business error:', error);
    res.status(500).json({ error: { message: 'Failed to verify business' } });
  }
});

// List recent reviews for moderation
router.get('/reviews', async (req, res) => {
  try {
    const { page = 1, limit = 20, minRating, maxRating } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = `
      SELECT r.*,
             u.name as user_name, u.email as user_email,
             b.name as business_name, b.slug as business_slug
      FROM reviews r
      JOIN users u ON r.user_id = u.id
      JOIN businesses b ON r.business_id = b.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (minRating) {
      query += ` AND r.rating >= $${paramIndex++}`;
      params.push(parseInt(minRating));
    }

    if (maxRating) {
      query += ` AND r.rating <= $${paramIndex++}`;
      params.push(parseInt(maxRating));
    }

    query += ` ORDER BY r.created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    const countResult = await pool.query('SELECT COUNT(*) FROM reviews');

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
    console.error('List reviews error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch reviews' } });
  }
});

// Delete a review (moderation)
router.delete('/reviews/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const reviewCheck = await pool.query(
      'SELECT business_id FROM reviews WHERE id = $1',
      [id]
    );

    if (reviewCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Review not found' } });
    }

    await pool.query('DELETE FROM reviews WHERE id = $1', [id]);

    // Clear cache
    await cache.delPattern(`business:${reviewCheck.rows[0].business_id}*`);

    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({ error: { message: 'Failed to delete review' } });
  }
});

export default router;
