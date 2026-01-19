import { Router, Request, Response, NextFunction } from 'express';
import { query, transaction } from '../services/database.js';
import { indexProduct, deleteProductFromIndex } from '../services/elasticsearch.js';
import { getRecommendations, cacheGet, cacheSet } from '../services/redis.js';
import { requireSeller, requireAdmin } from '../middleware/auth.js';
import type { PoolClient } from 'pg';

const router = Router();

interface ProductRow {
  id: number;
  title: string;
  slug: string;
  description?: string;
  price: string;
  compare_at_price?: string;
  images?: string[];
  rating?: string;
  review_count?: number;
  attributes?: Record<string, unknown>;
  category_name?: string;
  category_slug?: string;
  seller_name?: string;
  seller_rating?: string;
  stock_quantity?: string;
  category_id?: number;
  seller_id?: number;
  is_active?: boolean;
  created_at?: Date;
}

interface RecommendationRow {
  id: number;
  title: string;
  slug: string;
  price: string;
  images?: string[];
  rating?: string;
  score?: number;
  product_id: number;
}

interface SellerRow {
  id: number;
}

// List products
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { category, page = 0, limit = 20, sort = 'newest' } = req.query;

    let orderBy = 'p.created_at DESC';
    switch (sort) {
      case 'price_asc':
        orderBy = 'p.price ASC';
        break;
      case 'price_desc':
        orderBy = 'p.price DESC';
        break;
      case 'rating':
        orderBy = 'p.rating DESC NULLS LAST';
        break;
      case 'popular':
        orderBy = 'p.review_count DESC';
        break;
    }

    const offset = parseInt(String(page)) * parseInt(String(limit));

    let whereClause = 'WHERE p.is_active = true';
    const params: unknown[] = [];

    if (category) {
      params.push(category);
      whereClause += ` AND c.slug = $${params.length}`;
    }

    const result = await query<ProductRow>(
      `SELECT p.id, p.title, p.slug, p.description, p.price, p.compare_at_price,
              p.images, p.rating, p.review_count, p.attributes,
              c.name as category_name, c.slug as category_slug,
              s.business_name as seller_name,
              COALESCE(SUM(i.quantity - i.reserved), 0) as stock_quantity
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN sellers s ON p.seller_id = s.id
       LEFT JOIN inventory i ON p.id = i.product_id
       ${whereClause}
       GROUP BY p.id, c.name, c.slug, s.business_name
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(String(limit)), offset]
    );

    // Get total count
    const countResult = await query<{ total: string }>(
      `SELECT COUNT(DISTINCT p.id) as total
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereClause}`,
      params
    );

    res.json({
      products: result.rows,
      total: parseInt(countResult.rows[0]?.total || '0'),
      page: parseInt(String(page)),
      limit: parseInt(String(limit))
    });
  } catch (error) {
    next(error);
  }
});

// Get single product
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;

    // Try cache first
    const cacheKey = `product:${id}`;
    let product = await cacheGet<ProductRow>(cacheKey);

    if (!product) {
      const result = await query<ProductRow>(
        `SELECT p.*, c.name as category_name, c.slug as category_slug,
                s.business_name as seller_name, s.rating as seller_rating,
                COALESCE(SUM(i.quantity - i.reserved), 0) as stock_quantity
         FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         LEFT JOIN sellers s ON p.seller_id = s.id
         LEFT JOIN inventory i ON p.id = i.product_id
         WHERE p.id = $1 OR p.slug = $1
         GROUP BY p.id, c.name, c.slug, s.business_name, s.rating`,
        [id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }

      product = result.rows[0];
      if (!product) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }
      await cacheSet(cacheKey, product, 300); // Cache for 5 minutes
    }

    res.json({ product });
  } catch (error) {
    next(error);
  }
});

// Get product recommendations
router.get('/:id/recommendations', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;

    // Try Redis cache first
    let recommendations = await getRecommendations(id);

    if (!recommendations) {
      // Fallback to database
      const result = await query<RecommendationRow>(
        `SELECT p.id, p.title, p.slug, p.price, p.images, p.rating, pr.score
         FROM product_recommendations pr
         JOIN products p ON pr.recommended_product_id = p.id
         WHERE pr.product_id = $1 AND pr.recommendation_type = 'also_bought'
         ORDER BY pr.score DESC
         LIMIT 10`,
        [id]
      );
      recommendations = result.rows;
    } else {
      // Get full product data for cached recommendations
      const productIds = recommendations.map(r => r.product_id);
      if (productIds.length > 0) {
        const result = await query<RecommendationRow>(
          `SELECT id, title, slug, price, images, rating
           FROM products
           WHERE id = ANY($1)`,
          [productIds]
        );
        recommendations = result.rows;
      }
    }

    res.json({ recommendations });
  } catch (error) {
    next(error);
  }
});

// Create product (seller/admin only)
router.post('/', requireSeller, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      title, description, categoryId, price, compareAtPrice,
      images, attributes, initialStock
    } = req.body;

    // Generate slug
    const slug = title.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') + '-' + Date.now();

    // Get seller id for this user
    const sellerResult = await query<SellerRow>(
      'SELECT id FROM sellers WHERE user_id = $1',
      [req.user!.id]
    );

    let sellerId: number | null = null;
    const sellerRow = sellerResult.rows[0];
    if (sellerRow) {
      sellerId = sellerRow.id;
    } else if (req.user!.role === 'admin') {
      // Admin can create without being a seller
      sellerId = null;
    } else {
      res.status(400).json({ error: 'User is not a registered seller' });
      return;
    }

    const result = await transaction(async (client: PoolClient) => {
      const productResult = await client.query<ProductRow>(
        `INSERT INTO products (seller_id, title, slug, description, category_id, price, compare_at_price, images, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [sellerId, title, slug, description, categoryId, price, compareAtPrice, images || [], attributes || {}]
      );

      const product = productResult.rows[0];
      if (!product) {
        throw new Error('Failed to create product');
      }

      // Add initial inventory
      if (initialStock && initialStock > 0) {
        await client.query(
          `INSERT INTO inventory (product_id, warehouse_id, quantity)
           SELECT $1, id, $2 FROM warehouses WHERE is_active = true LIMIT 1`,
          [product.id, initialStock]
        );
      }

      return product;
    });

    // Index in Elasticsearch
    await indexProduct({
      ...result,
      id: result.id,
      title: result.title,
      price: result.price,
      stock_quantity: initialStock || 0
    });

    res.status(201).json({ product: result });
  } catch (error) {
    next(error);
  }
});

// Update product
router.put('/:id', requireSeller, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, description, categoryId, price, compareAtPrice, images, attributes, isActive } = req.body;

    const result = await query<ProductRow>(
      `UPDATE products
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           category_id = COALESCE($3, category_id),
           price = COALESCE($4, price),
           compare_at_price = COALESCE($5, compare_at_price),
           images = COALESCE($6, images),
           attributes = COALESCE($7, attributes),
           is_active = COALESCE($8, is_active),
           updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [title, description, categoryId, price, compareAtPrice, images, attributes, isActive, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    // Update Elasticsearch index
    const product = result.rows[0];
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    await indexProduct({
      ...product,
      id: product.id,
      title: product.title,
      price: product.price,
      stock_quantity: product.stock_quantity ? parseInt(product.stock_quantity) : undefined
    });

    res.json({ product });
  } catch (error) {
    next(error);
  }
});

// Delete product
router.delete('/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const id = req.params.id as string;

    await query('DELETE FROM products WHERE id = $1', [id]);
    await deleteProductFromIndex(id);

    res.json({ message: 'Product deleted' });
  } catch (error) {
    next(error);
  }
});

// Update inventory
router.put('/:id/inventory', requireSeller, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { quantity, warehouseId = 1 } = req.body;

    const result = await query(
      `INSERT INTO inventory (product_id, warehouse_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_id, warehouse_id)
       DO UPDATE SET quantity = $3
       RETURNING *`,
      [id, warehouseId, quantity]
    );

    res.json({ inventory: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

export default router;
