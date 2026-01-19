import { Router, Request, Response } from 'express';
import db from '../db/index.js';

const router = Router();

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  created_at: Date;
}

interface ProductRow {
  id: number;
  title: string;
  price: string;
  shop_name: string;
  shop_slug: string;
  shop_rating: number;
}

interface CountRow {
  count: string;
}

// Get all categories
router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await db.query<CategoryRow>(
      'SELECT * FROM categories ORDER BY name ASC'
    );
    res.json({ categories: result.rows });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to get categories' });
  }
});

// Get category by slug
router.get('/slug/:slug', async (req: Request<{ slug: string }>, res: Response) => {
  try {
    const { slug } = req.params;

    const result = await db.query<CategoryRow>(
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
router.get('/:id/products', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    const { sort = 'newest', limit = '20', offset = '0' } = req.query as {
      sort?: string;
      limit?: string;
      offset?: string;
    };

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

    const result = await db.query<ProductRow>(
      `SELECT p.*, s.name as shop_name, s.slug as shop_slug, s.rating as shop_rating
       FROM products p
       JOIN shops s ON p.shop_id = s.id
       WHERE p.category_id = $1 AND p.is_active = true AND p.quantity > 0 AND s.is_active = true
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [parseInt(id), parseInt(limit), parseInt(offset)]
    );

    const countResult = await db.query<CountRow>(
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
