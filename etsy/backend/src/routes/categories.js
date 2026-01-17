import { Router } from 'express';
import db from '../db/index.js';

const router = Router();

// Get all categories
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM categories ORDER BY name ASC'
    );
    res.json({ categories: result.rows });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// Get category by slug
router.get('/slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const result = await db.query(
      'SELECT * FROM categories WHERE slug = $1',
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json({ category: result.rows[0] });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({ error: 'Failed to get category' });
  }
});

// Get products in category
router.get('/:id/products', async (req, res) => {
  try {
    const { id } = req.params;
    const { sort = 'newest', limit = 20, offset = 0 } = req.query;

    let orderBy = 'p.created_at DESC';
    switch (sort) {
      case 'price_asc':
        orderBy = 'p.price ASC';
        break;
      case 'price_desc':
        orderBy = 'p.price DESC';
        break;
      case 'popular':
        orderBy = 'p.view_count DESC';
        break;
    }

    const result = await db.query(
      `SELECT p.*, s.name as shop_name, s.slug as shop_slug, s.rating as shop_rating
       FROM products p
       JOIN shops s ON p.shop_id = s.id
       WHERE p.category_id = $1 AND p.is_active = true AND p.quantity > 0 AND s.is_active = true
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [parseInt(id), parseInt(limit), parseInt(offset)]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM products p
       JOIN shops s ON p.shop_id = s.id
       WHERE p.category_id = $1 AND p.is_active = true AND p.quantity > 0 AND s.is_active = true`,
      [parseInt(id)]
    );

    res.json({
      products: result.rows,
      total: parseInt(countResult.rows[0].count),
    });
  } catch (error) {
    console.error('Get category products error:', error);
    res.status(500).json({ error: 'Failed to get products' });
  }
});

export default router;
