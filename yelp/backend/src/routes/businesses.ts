import { Router } from 'express';
import { pool } from '../utils/db.js';
import { cache } from '../utils/redis.js';
import { authenticate, optionalAuth, requireBusinessOwner } from '../middleware/auth.js';
import { publishBusinessReindex } from '../utils/queue.js';

const router = Router();

// Helper to generate slug
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Get all businesses with pagination
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, city, category, minRating } = req.query;
    const offset = (page - 1) * limit;

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

    const params = [];
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
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(DISTINCT b.id)
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      WHERE 1=1
    `;
    const countParams = [];
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

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      businesses: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Get businesses error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch businesses' } });
  }
});

// Get nearby businesses
router.get('/nearby', async (req, res) => {
  try {
    const { latitude, longitude, distance = 10, limit = 20 } = req.query;

    if (!latitude || !longitude) {
      return res.status(400).json({ error: { message: 'Latitude and longitude are required' } });
    }

    const query = `
      SELECT b.*,
             ST_Distance(b.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1000 as distance_km,
             array_agg(DISTINCT c.slug) FILTER (WHERE c.slug IS NOT NULL) as categories,
             array_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL) as category_names,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as photo_url
      FROM businesses b
      LEFT JOIN business_categories bc ON b.id = bc.business_id
      LEFT JOIN categories c ON bc.category_id = c.id
      WHERE ST_DWithin(
        b.location,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3 * 1000
      )
      GROUP BY b.id
      ORDER BY distance_km ASC
      LIMIT $4
    `;

    const result = await pool.query(query, [
      parseFloat(longitude),
      parseFloat(latitude),
      parseFloat(distance),
      parseInt(limit)
    ]);

    res.json({ businesses: result.rows });
  } catch (error) {
    console.error('Get nearby businesses error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch nearby businesses' } });
  }
});

// Get business by ID or slug
router.get('/:idOrSlug', optionalAuth, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const cacheKey = `business:${idOrSlug}`;

    // Try cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ business: cached });
    }

    // Check if it's a UUID or slug
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);

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

    const result = await pool.query(query, [idOrSlug]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Business not found' } });
    }

    const business = result.rows[0];

    // Get business hours
    const hoursResult = await pool.query(
      'SELECT day_of_week, open_time, close_time, is_closed FROM business_hours WHERE business_id = $1 ORDER BY day_of_week',
      [business.id]
    );
    business.hours = hoursResult.rows;

    // Get photos
    const photosResult = await pool.query(
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
});

// Create a new business
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      name,
      description,
      address,
      city,
      state,
      zip_code,
      country = 'USA',
      latitude,
      longitude,
      phone,
      website,
      email,
      price_level,
      categories = []
    } = req.body;

    if (!name || !address || !city || !state || !zip_code || !latitude || !longitude) {
      return res.status(400).json({
        error: { message: 'Name, address, city, state, zip_code, latitude, and longitude are required' }
      });
    }

    // Generate unique slug
    let slug = generateSlug(name);
    const existingSlug = await pool.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
    if (existingSlug.rows.length > 0) {
      slug = `${slug}-${Date.now()}`;
    }

    // Insert business
    const result = await pool.query(
      `INSERT INTO businesses (name, slug, description, address, city, state, zip_code, country, latitude, longitude, phone, website, email, price_level, owner_id, is_claimed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true)
       RETURNING *`,
      [name, slug, description, address, city, state, zip_code, country, latitude, longitude, phone, website, email, price_level, req.user.id]
    );

    const business = result.rows[0];

    // Add categories
    if (categories.length > 0) {
      const categoryValues = categories.map((catId, index) => `($1, $${index + 2})`).join(', ');
      await pool.query(
        `INSERT INTO business_categories (business_id, category_id) VALUES ${categoryValues}`,
        [business.id, ...categories]
      );
    }

    // Update user role if not already a business owner
    if (req.user.role === 'user') {
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['business_owner', req.user.id]);
    }

    // Get category info for indexing
    const catResult = await pool.query(
      `SELECT c.slug, c.name FROM categories c
       JOIN business_categories bc ON c.id = bc.category_id
       WHERE bc.business_id = $1`,
      [business.id]
    );

    // Publish to queue for async Elasticsearch indexing
    publishBusinessReindex(business.id);

    res.status(201).json({ business });
  } catch (error) {
    console.error('Create business error:', error);
    res.status(500).json({ error: { message: 'Failed to create business' } });
  }
});

// Update business
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Check ownership
    const ownerCheck = await pool.query(
      'SELECT owner_id FROM businesses WHERE id = $1',
      [id]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Business not found' } });
    }

    if (ownerCheck.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Not authorized to update this business' } });
    }

    const allowedFields = ['name', 'description', 'address', 'city', 'state', 'zip_code', 'phone', 'website', 'email', 'price_level', 'latitude', 'longitude'];
    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramIndex++}`);
        values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: { message: 'No updates provided' } });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE businesses SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    const business = result.rows[0];

    // Update categories if provided
    if (req.body.categories) {
      await pool.query('DELETE FROM business_categories WHERE business_id = $1', [id]);
      if (req.body.categories.length > 0) {
        const categoryValues = req.body.categories.map((catId, index) => `($1, $${index + 2})`).join(', ');
        await pool.query(
          `INSERT INTO business_categories (business_id, category_id) VALUES ${categoryValues}`,
          [id, ...req.body.categories]
        );
      }
    }

    // Get updated category info
    const catResult = await pool.query(
      `SELECT c.slug, c.name FROM categories c
       JOIN business_categories bc ON c.id = bc.category_id
       WHERE bc.business_id = $1`,
      [id]
    );

    // Publish to queue for async Elasticsearch reindex
    publishBusinessReindex(id);

    // Clear cache
    await cache.delPattern(`business:${id}*`);
    await cache.delPattern(`business:${business.slug}*`);

    res.json({ business });
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({ error: { message: 'Failed to update business' } });
  }
});

// Add business hours
router.post('/:id/hours', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { hours } = req.body;

    // Check ownership
    const ownerCheck = await pool.query(
      'SELECT owner_id FROM businesses WHERE id = $1',
      [id]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Business not found' } });
    }

    if (ownerCheck.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: { message: 'Not authorized' } });
    }

    // Delete existing hours and insert new ones
    await pool.query('DELETE FROM business_hours WHERE business_id = $1', [id]);

    for (const hour of hours) {
      await pool.query(
        `INSERT INTO business_hours (business_id, day_of_week, open_time, close_time, is_closed)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, hour.day_of_week, hour.open_time, hour.close_time, hour.is_closed || false]
      );
    }

    // Clear cache
    await cache.delPattern(`business:${id}*`);

    res.json({ message: 'Hours updated successfully' });
  } catch (error) {
    console.error('Update hours error:', error);
    res.status(500).json({ error: { message: 'Failed to update hours' } });
  }
});

// Add business photo
router.post('/:id/photos', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { url, caption, is_primary = false } = req.body;

    if (!url) {
      return res.status(400).json({ error: { message: 'Photo URL is required' } });
    }

    // Check if business exists
    const businessCheck = await pool.query('SELECT id FROM businesses WHERE id = $1', [id]);
    if (businessCheck.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Business not found' } });
    }

    // If setting as primary, unset other primary photos
    if (is_primary) {
      await pool.query(
        'UPDATE business_photos SET is_primary = false WHERE business_id = $1',
        [id]
      );
    }

    const result = await pool.query(
      `INSERT INTO business_photos (business_id, url, caption, is_primary, uploaded_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, url, caption, is_primary, req.user.id]
    );

    // Update photo count
    await pool.query(
      'UPDATE businesses SET photo_count = photo_count + 1 WHERE id = $1',
      [id]
    );

    // Clear cache
    await cache.delPattern(`business:${id}*`);

    res.status(201).json({ photo: result.rows[0] });
  } catch (error) {
    console.error('Add photo error:', error);
    res.status(500).json({ error: { message: 'Failed to add photo' } });
  }
});

// Claim a business
router.post('/:id/claim', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'SELECT is_claimed, owner_id FROM businesses WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Business not found' } });
    }

    if (result.rows[0].is_claimed) {
      return res.status(409).json({ error: { message: 'Business already claimed' } });
    }

    await pool.query(
      'UPDATE businesses SET is_claimed = true, owner_id = $1 WHERE id = $2',
      [req.user.id, id]
    );

    // Update user role
    if (req.user.role === 'user') {
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['business_owner', req.user.id]);
    }

    res.json({ message: 'Business claimed successfully' });
  } catch (error) {
    console.error('Claim business error:', error);
    res.status(500).json({ error: { message: 'Failed to claim business' } });
  }
});

// Get reviews for a business
router.get('/:id/reviews', async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10, sort = 'recent' } = req.query;
    const offset = (page - 1) * limit;

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

    const result = await pool.query(query, [id, parseInt(limit), parseInt(offset)]);

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM reviews WHERE business_id = $1',
      [id]
    );

    res.json({
      reviews: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        pages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    console.error('Get reviews error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch reviews' } });
  }
});

export default router;
