import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/index.js';
import { isAuthenticated } from '../middleware/auth.js';
import { indexProduct, deleteProductFromIndex, searchProducts, getSimilarProducts } from '../services/elasticsearch.js';

// Shared modules
import {
  getCachedProduct,
  invalidateProductCache,
  cacheAside,
  CACHE_KEYS,
  CACHE_TTL,
} from '../shared/cache.js';
import {
  productViews,
  searchQueries,
  searchLatency,
  searchResultsCount,
} from '../shared/metrics.js';
import { searchLogger as logger } from '../shared/logger.js';
import { searchCircuitBreaker, createCircuitBreaker } from '../shared/circuit-breaker.js';

const router = Router();

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

// Initialize search circuit breaker with fallback
searchCircuitBreaker.init(
  async (query, filters) => {
    return await searchProducts(query, filters);
  },
  async (query, filters) => {
    // Fallback: search from PostgreSQL when Elasticsearch is down
    logger.warn({ query }, 'Elasticsearch unavailable, falling back to PostgreSQL');
    return await fallbackSearch(query, filters);
  }
);

// Fallback search using PostgreSQL
async function fallbackSearch(query, filters = {}) {
  let sql = `
    SELECT p.*, s.name as shop_name, s.slug as shop_slug, s.rating as shop_rating, c.name as category_name
    FROM products p
    JOIN shops s ON p.shop_id = s.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.is_active = true AND p.quantity > 0 AND s.is_active = true
  `;
  const params = [];

  if (query) {
    params.push(`%${query}%`);
    sql += ` AND (p.title ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
  }

  if (filters.categoryId) {
    params.push(parseInt(filters.categoryId));
    sql += ` AND p.category_id = $${params.length}`;
  }

  sql += ` ORDER BY p.view_count DESC LIMIT ${filters.limit || 20} OFFSET ${filters.offset || 0}`;

  const result = await db.query(sql, params);
  return {
    products: result.rows,
    total: result.rows.length,
    aggregations: null,
    fallback: true,
  };
}

// Search products (Elasticsearch with circuit breaker)
router.get('/search', async (req, res) => {
  const startTime = Date.now();
  try {
    const { q, categoryId, priceMin, priceMax, isVintage, isHandmade, freeShipping, sort, limit = 20, offset = 0 } = req.query;

    const hasFilters = !!(categoryId || priceMin || priceMax || isVintage || isHandmade || freeShipping);

    // Try to get from cache first for common queries
    const cacheKey = `${CACHE_KEYS.SEARCH}${q || 'all'}:${JSON.stringify({ categoryId, priceMin, priceMax, isVintage, isHandmade, freeShipping, sort, limit, offset })}`;

    const results = await cacheAside(
      cacheKey,
      async () => {
        return await searchCircuitBreaker.fire(q, {
          categoryId,
          priceMin,
          priceMax,
          isVintage,
          isHandmade,
          freeShipping,
          sort,
          limit: parseInt(limit),
          offset: parseInt(offset),
        });
      },
      CACHE_TTL.SEARCH,
      'search'
    );

    // Record metrics
    const duration = (Date.now() - startTime) / 1000;
    searchQueries.labels(hasFilters ? 'yes' : 'no').inc();
    searchLatency.labels(q ? 'keyword' : 'browse').observe(duration);
    searchResultsCount.labels(q ? 'keyword' : 'browse').observe(results.total);

    res.json(results);
  } catch (error) {
    logger.error({ error, query: req.query }, 'Search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get all products (with pagination and filters)
router.get('/', async (req, res) => {
  try {
    const { categoryId, priceMin, priceMax, isVintage, isHandmade, sort = 'newest', limit = 20, offset = 0 } = req.query;

    let query = `
      SELECT p.*, s.name as shop_name, s.slug as shop_slug, s.rating as shop_rating, c.name as category_name
      FROM products p
      JOIN shops s ON p.shop_id = s.id
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_active = true AND p.quantity > 0 AND s.is_active = true
    `;
    const params = [];

    if (categoryId) {
      params.push(parseInt(categoryId));
      query += ` AND p.category_id = $${params.length}`;
    }

    if (priceMin) {
      params.push(parseFloat(priceMin));
      query += ` AND p.price >= $${params.length}`;
    }

    if (priceMax) {
      params.push(parseFloat(priceMax));
      query += ` AND p.price <= $${params.length}`;
    }

    if (isVintage === 'true') {
      query += ' AND p.is_vintage = true';
    }

    if (isHandmade === 'true') {
      query += ' AND p.is_handmade = true';
    }

    // Sort
    switch (sort) {
      case 'price_asc':
        query += ' ORDER BY p.price ASC';
        break;
      case 'price_desc':
        query += ' ORDER BY p.price DESC';
        break;
      case 'popular':
        query += ' ORDER BY p.view_count DESC';
        break;
      default:
        query += ' ORDER BY p.created_at DESC';
    }

    params.push(parseInt(limit), parseInt(offset));
    query += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await db.query(query, params);

    res.json({ products: result.rows });
  } catch (error) {
    logger.error({ error }, 'Get products error');
    res.status(500).json({ error: 'Failed to get products' });
  }
});

// Get trending products (with caching)
router.get('/trending', async (req, res) => {
  try {
    const { limit = 12 } = req.query;
    const cacheKey = `${CACHE_KEYS.TRENDING}${limit}`;

    const products = await cacheAside(
      cacheKey,
      async () => {
        const result = await db.query(
          `SELECT p.*, s.name as shop_name, s.slug as shop_slug, s.rating as shop_rating, c.name as category_name
           FROM products p
           JOIN shops s ON p.shop_id = s.id
           LEFT JOIN categories c ON p.category_id = c.id
           WHERE p.is_active = true AND p.quantity > 0 AND s.is_active = true
           ORDER BY (p.view_count * 0.3 + p.favorite_count * 0.7) DESC, p.created_at DESC
           LIMIT $1`,
          [parseInt(limit)]
        );
        return result.rows;
      },
      CACHE_TTL.TRENDING,
      'trending'
    );

    res.json({ products });
  } catch (error) {
    logger.error({ error }, 'Get trending products error');
    res.status(500).json({ error: 'Failed to get trending products' });
  }
});

// Get product by ID (with caching)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const productId = parseInt(id);

    // Get product from cache or database
    const product = await getCachedProduct(productId, async () => {
      const result = await db.query(
        `SELECT p.*, s.name as shop_name, s.slug as shop_slug, s.rating as shop_rating,
                s.sales_count as shop_sales_count, s.description as shop_description,
                s.logo_image as shop_logo, s.location as shop_location,
                c.name as category_name
         FROM products p
         JOIN shops s ON p.shop_id = s.id
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.id = $1`,
        [productId]
      );
      return result.rows.length > 0 ? result.rows[0] : null;
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Increment view count asynchronously (don't block response)
    db.query(
      'UPDATE products SET view_count = view_count + 1 WHERE id = $1',
      [productId]
    ).catch((err) => logger.error({ error: err }, 'Failed to increment view count'));

    // Record view history if user is logged in
    if (req.session && req.session.userId) {
      db.query(
        'INSERT INTO view_history (user_id, product_id) VALUES ($1, $2)',
        [req.session.userId, productId]
      ).catch((err) => logger.error({ error: err }, 'Failed to record view history'));
    }

    // Record metrics
    productViews.labels(product.category_id?.toString() || 'unknown').inc();

    // Get similar products (through circuit breaker)
    let similarProducts = [];
    try {
      similarProducts = await getSimilarProducts(productId, 6);
    } catch (error) {
      logger.warn({ error }, 'Failed to get similar products');
    }

    res.json({
      product,
      similarProducts,
    });
  } catch (error) {
    logger.error({ error }, 'Get product error');
    res.status(500).json({ error: 'Failed to get product' });
  }
});

// Create product (requires auth and shop ownership)
router.post('/', isAuthenticated, async (req, res) => {
  try {
    const {
      shopId,
      title,
      description,
      price,
      compareAtPrice,
      quantity,
      categoryId,
      tags,
      images,
      isVintage,
      isHandmade,
      shippingPrice,
      processingTime,
    } = req.body;

    // Check shop ownership
    if (!req.session.shopIds || !req.session.shopIds.includes(parseInt(shopId))) {
      return res.status(403).json({ error: 'You do not own this shop' });
    }

    if (!title || !price) {
      return res.status(400).json({ error: 'Title and price are required' });
    }

    const result = await db.query(
      `INSERT INTO products (shop_id, title, description, price, compare_at_price, quantity, category_id, tags, images, is_vintage, is_handmade, shipping_price, processing_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        parseInt(shopId),
        title,
        description || null,
        parseFloat(price),
        compareAtPrice ? parseFloat(compareAtPrice) : null,
        parseInt(quantity) || 1,
        categoryId ? parseInt(categoryId) : null,
        tags || [],
        images || [],
        isVintage || false,
        isHandmade !== false,
        parseFloat(shippingPrice) || 0,
        processingTime || null,
      ]
    );

    const product = result.rows[0];

    // Get shop and category info for indexing
    const shopResult = await db.query('SELECT name, rating, sales_count FROM shops WHERE id = $1', [parseInt(shopId)]);
    const categoryResult = categoryId
      ? await db.query('SELECT name FROM categories WHERE id = $1', [parseInt(categoryId)])
      : { rows: [{ name: null }] };

    // Index in Elasticsearch
    await indexProduct({
      ...product,
      shop_name: shopResult.rows[0].name,
      shop_rating: shopResult.rows[0].rating,
      shop_sales_count: shopResult.rows[0].sales_count,
      category_name: categoryResult.rows[0]?.name,
    });

    // Invalidate related caches
    await invalidateProductCache(product.id, parseInt(shopId), categoryId ? parseInt(categoryId) : null);

    logger.info({ productId: product.id, shopId }, 'Product created');
    res.status(201).json({ product });
  } catch (error) {
    logger.error({ error }, 'Create product error');
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product (requires auth and shop ownership)
router.put('/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const productId = parseInt(id);

    // Get product to check shop ownership
    const productCheck = await db.query('SELECT shop_id, category_id FROM products WHERE id = $1', [productId]);
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const shopId = productCheck.rows[0].shop_id;
    const oldCategoryId = productCheck.rows[0].category_id;

    if (!req.session.shopIds || !req.session.shopIds.includes(shopId)) {
      return res.status(403).json({ error: 'You do not own this shop' });
    }

    const {
      title,
      description,
      price,
      compareAtPrice,
      quantity,
      categoryId,
      tags,
      images,
      isVintage,
      isHandmade,
      shippingPrice,
      processingTime,
      isActive,
    } = req.body;

    const result = await db.query(
      `UPDATE products SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        price = COALESCE($3, price),
        compare_at_price = COALESCE($4, compare_at_price),
        quantity = COALESCE($5, quantity),
        category_id = COALESCE($6, category_id),
        tags = COALESCE($7, tags),
        images = COALESCE($8, images),
        is_vintage = COALESCE($9, is_vintage),
        is_handmade = COALESCE($10, is_handmade),
        shipping_price = COALESCE($11, shipping_price),
        processing_time = COALESCE($12, processing_time),
        is_active = COALESCE($13, is_active),
        updated_at = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        title,
        description,
        price ? parseFloat(price) : null,
        compareAtPrice ? parseFloat(compareAtPrice) : null,
        quantity ? parseInt(quantity) : null,
        categoryId ? parseInt(categoryId) : null,
        tags,
        images,
        isVintage,
        isHandmade,
        shippingPrice ? parseFloat(shippingPrice) : null,
        processingTime,
        isActive,
        productId,
      ]
    );

    const product = result.rows[0];

    // Get shop and category info for indexing
    const shopResult = await db.query('SELECT name, rating, sales_count FROM shops WHERE id = $1', [shopId]);
    const categoryResult = product.category_id
      ? await db.query('SELECT name FROM categories WHERE id = $1', [product.category_id])
      : { rows: [{ name: null }] };

    // Re-index in Elasticsearch
    await indexProduct({
      ...product,
      shop_name: shopResult.rows[0].name,
      shop_rating: shopResult.rows[0].rating,
      shop_sales_count: shopResult.rows[0].sales_count,
      category_name: categoryResult.rows[0]?.name,
    });

    // Invalidate caches (both old and new category if changed)
    await invalidateProductCache(productId, shopId, product.category_id);
    if (oldCategoryId && oldCategoryId !== product.category_id) {
      await invalidateProductCache(productId, shopId, oldCategoryId);
    }

    logger.info({ productId, shopId }, 'Product updated');
    res.json({ product });
  } catch (error) {
    logger.error({ error }, 'Update product error');
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete product (requires auth and shop ownership)
router.delete('/:id', isAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const productId = parseInt(id);

    // Get product to check shop ownership
    const productCheck = await db.query('SELECT shop_id, category_id FROM products WHERE id = $1', [productId]);
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const shopId = productCheck.rows[0].shop_id;
    const categoryId = productCheck.rows[0].category_id;

    if (!req.session.shopIds || !req.session.shopIds.includes(shopId)) {
      return res.status(403).json({ error: 'You do not own this shop' });
    }

    // Soft delete
    await db.query('UPDATE products SET is_active = false WHERE id = $1', [productId]);

    // Remove from Elasticsearch
    await deleteProductFromIndex(productId);

    // Invalidate caches
    await invalidateProductCache(productId, shopId, categoryId);

    logger.info({ productId, shopId }, 'Product deleted');
    res.json({ message: 'Product deleted' });
  } catch (error) {
    logger.error({ error }, 'Delete product error');
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Upload product images
router.post('/upload', isAuthenticated, upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const imageUrls = req.files.map((file) => `/uploads/${file.filename}`);
    res.json({ images: imageUrls });
  } catch (error) {
    logger.error({ error }, 'Upload error');
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

export default router;
