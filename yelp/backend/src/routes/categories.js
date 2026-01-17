import { Router } from 'express';
import { pool } from '../utils/db.js';
import { cache } from '../utils/redis.js';

const router = Router();

// Get all categories
router.get('/', async (req, res) => {
  try {
    const cacheKey = 'categories:all';
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ categories: cached });
    }

    const result = await pool.query(`
      SELECT c.*,
             p.name as parent_name, p.slug as parent_slug,
             (SELECT COUNT(*) FROM business_categories bc WHERE bc.category_id = c.id) as business_count
      FROM categories c
      LEFT JOIN categories p ON c.parent_id = p.id
      ORDER BY c.parent_id NULLS FIRST, c.name
    `);

    // Organize into tree structure
    const categories = result.rows;
    const parentCategories = categories.filter(c => !c.parent_id);
    const childCategories = categories.filter(c => c.parent_id);

    const categoryTree = parentCategories.map(parent => ({
      ...parent,
      subcategories: childCategories.filter(child => child.parent_id === parent.id)
    }));

    // Cache for 1 hour
    await cache.set(cacheKey, categoryTree, 3600);

    res.json({ categories: categoryTree });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch categories' } });
  }
});

// Get category by slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const result = await pool.query(`
      SELECT c.*,
             p.name as parent_name, p.slug as parent_slug,
             (SELECT COUNT(*) FROM business_categories bc WHERE bc.category_id = c.id) as business_count
      FROM categories c
      LEFT JOIN categories p ON c.parent_id = p.id
      WHERE c.slug = $1
    `, [slug]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Category not found' } });
    }

    const category = result.rows[0];

    // Get subcategories
    const subResult = await pool.query(`
      SELECT c.*,
             (SELECT COUNT(*) FROM business_categories bc WHERE bc.category_id = c.id) as business_count
      FROM categories c
      WHERE c.parent_id = $1
      ORDER BY c.name
    `, [category.id]);

    category.subcategories = subResult.rows;

    res.json({ category });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch category' } });
  }
});

// Get businesses in a category
router.get('/:slug/businesses', async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 20, city, minRating, sortBy = 'rating' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let orderBy = 'b.rating DESC, b.review_count DESC';
    if (sortBy === 'review_count') orderBy = 'b.review_count DESC, b.rating DESC';
    if (sortBy === 'name') orderBy = 'b.name ASC';

    let query = `
      SELECT b.*,
             array_agg(DISTINCT c2.slug) FILTER (WHERE c2.slug IS NOT NULL) as categories,
             (SELECT url FROM business_photos WHERE business_id = b.id AND is_primary = true LIMIT 1) as photo_url
      FROM businesses b
      JOIN business_categories bc ON b.id = bc.business_id
      JOIN categories c ON bc.category_id = c.id
      LEFT JOIN business_categories bc2 ON b.id = bc2.business_id
      LEFT JOIN categories c2 ON bc2.category_id = c2.id
      WHERE c.slug = $1 OR c.parent_id = (SELECT id FROM categories WHERE slug = $1)
    `;

    const params = [slug];
    let paramIndex = 2;

    if (city) {
      query += ` AND LOWER(b.city) = LOWER($${paramIndex++})`;
      params.push(city);
    }

    if (minRating) {
      query += ` AND b.rating >= $${paramIndex++}`;
      params.push(parseFloat(minRating));
    }

    query += ` GROUP BY b.id ORDER BY ${orderBy}`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(DISTINCT b.id)
      FROM businesses b
      JOIN business_categories bc ON b.id = bc.business_id
      JOIN categories c ON bc.category_id = c.id
      WHERE c.slug = $1 OR c.parent_id = (SELECT id FROM categories WHERE slug = $1)
    `;
    const countParams = [slug];
    let countParamIndex = 2;

    if (city) {
      countQuery += ` AND LOWER(b.city) = LOWER($${countParamIndex++})`;
      countParams.push(city);
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
        pages: Math.ceil(countResult.rows[0].count / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get category businesses error:', error);
    res.status(500).json({ error: { message: 'Failed to fetch businesses' } });
  }
});

export default router;
