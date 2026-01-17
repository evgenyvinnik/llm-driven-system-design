import { Router } from 'express';
import db from '../db/index.js';
import { isAuthenticated } from '../middleware/auth.js';

const router = Router();

// Get user's favorites
router.get('/', isAuthenticated, async (req, res) => {
  try {
    const { type } = req.query; // 'product' or 'shop'

    let query = `
      SELECT f.*,
        CASE
          WHEN f.favoritable_type = 'product' THEN p.title
          WHEN f.favoritable_type = 'shop' THEN s.name
        END as name,
        CASE
          WHEN f.favoritable_type = 'product' THEN p.images[1]
          WHEN f.favoritable_type = 'shop' THEN s.logo_image
        END as image,
        CASE
          WHEN f.favoritable_type = 'product' THEN p.price::text
          ELSE NULL
        END as price,
        CASE
          WHEN f.favoritable_type = 'product' THEN ps.slug
          WHEN f.favoritable_type = 'shop' THEN s.slug
        END as slug
      FROM favorites f
      LEFT JOIN products p ON f.favoritable_type = 'product' AND f.favoritable_id = p.id
      LEFT JOIN shops ps ON p.shop_id = ps.id
      LEFT JOIN shops s ON f.favoritable_type = 'shop' AND f.favoritable_id = s.id
      WHERE f.user_id = $1
    `;
    const params = [req.session.userId];

    if (type) {
      query += ` AND f.favoritable_type = $${params.length + 1}`;
      params.push(type);
    }

    query += ' ORDER BY f.created_at DESC';

    const result = await db.query(query, params);

    res.json({ favorites: result.rows });
  } catch (error) {
    console.error('Get favorites error:', error);
    res.status(500).json({ error: 'Failed to get favorites' });
  }
});

// Add to favorites
router.post('/', isAuthenticated, async (req, res) => {
  try {
    const { type, id } = req.body;

    if (!type || !id) {
      return res.status(400).json({ error: 'Type and ID are required' });
    }

    if (!['product', 'shop'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    // Check if item exists
    const table = type === 'product' ? 'products' : 'shops';
    const existsResult = await db.query(`SELECT id FROM ${table} WHERE id = $1`, [parseInt(id)]);
    if (existsResult.rows.length === 0) {
      return res.status(404).json({ error: `${type} not found` });
    }

    // Add to favorites
    await db.query(
      `INSERT INTO favorites (user_id, favoritable_type, favoritable_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, favoritable_type, favoritable_id) DO NOTHING`,
      [req.session.userId, type, parseInt(id)]
    );

    // Update favorite count if product
    if (type === 'product') {
      await db.query(
        'UPDATE products SET favorite_count = favorite_count + 1 WHERE id = $1',
        [parseInt(id)]
      );
    }

    res.status(201).json({ message: 'Added to favorites' });
  } catch (error) {
    console.error('Add favorite error:', error);
    res.status(500).json({ error: 'Failed to add to favorites' });
  }
});

// Remove from favorites
router.delete('/:type/:id', isAuthenticated, async (req, res) => {
  try {
    const { type, id } = req.params;

    const result = await db.query(
      'DELETE FROM favorites WHERE user_id = $1 AND favoritable_type = $2 AND favoritable_id = $3 RETURNING id',
      [req.session.userId, type, parseInt(id)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Favorite not found' });
    }

    // Update favorite count if product
    if (type === 'product') {
      await db.query(
        'UPDATE products SET favorite_count = GREATEST(favorite_count - 1, 0) WHERE id = $1',
        [parseInt(id)]
      );
    }

    res.json({ message: 'Removed from favorites' });
  } catch (error) {
    console.error('Remove favorite error:', error);
    res.status(500).json({ error: 'Failed to remove from favorites' });
  }
});

// Check if item is favorited
router.get('/check/:type/:id', isAuthenticated, async (req, res) => {
  try {
    const { type, id } = req.params;

    const result = await db.query(
      'SELECT id FROM favorites WHERE user_id = $1 AND favoritable_type = $2 AND favoritable_id = $3',
      [req.session.userId, type, parseInt(id)]
    );

    res.json({ isFavorited: result.rows.length > 0 });
  } catch (error) {
    console.error('Check favorite error:', error);
    res.status(500).json({ error: 'Failed to check favorite' });
  }
});

export default router;
