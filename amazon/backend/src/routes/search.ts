import { Router, Request, Response, NextFunction } from 'express';
import { searchProducts, SearchFilters, SearchResult } from '../services/elasticsearch.js';
import { query } from '../services/database.js';

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
  category_name?: string;
  category_slug?: string;
  stock_quantity?: string;
}

interface FallbackFilters {
  category?: string;
  minPrice?: string;
  maxPrice?: string;
  inStock?: boolean;
  sortBy?: string;
}

interface FallbackSearchResult {
  products: ProductRow[];
  total: number;
  aggregations: Record<string, unknown>;
  page: number;
  limit: number;
}

// Search products
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const {
      q: queryText,
      category,
      minPrice,
      maxPrice,
      inStock,
      minRating,
      sortBy,
      page = 0,
      limit = 20
    } = req.query;

    // Try Elasticsearch first
    const filters: SearchFilters = {
      category: category as string | undefined,
      minPrice: minPrice as string | undefined,
      maxPrice: maxPrice as string | undefined,
      inStock: inStock === 'true',
      minRating: minRating as string | undefined,
      sortBy: sortBy as SearchFilters['sortBy']
    };

    const result = await searchProducts(
      queryText as string | undefined,
      filters,
      parseInt(String(page)),
      parseInt(String(limit))
    );

    // If Elasticsearch is not available, fallback to PostgreSQL
    if (result.products.length === 0 && queryText) {
      const pgResult = await fallbackSearch(
        queryText as string,
        {
          category: category as string | undefined,
          minPrice: minPrice as string | undefined,
          maxPrice: maxPrice as string | undefined,
          inStock: inStock === 'true',
          sortBy: sortBy as string | undefined
        },
        parseInt(String(page)),
        parseInt(String(limit))
      );

      res.json(pgResult);
      return;
    }

    res.json({
      products: result.products,
      total: result.total,
      aggregations: result.aggregations,
      page: parseInt(String(page)),
      limit: parseInt(String(limit))
    });
  } catch (error) {
    next(error);
  }
});

// Autocomplete suggestions
router.get('/suggestions', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { q } = req.query;

    if (!q || String(q).length < 2) {
      res.json({ suggestions: [] });
      return;
    }

    // Simple PostgreSQL-based suggestions
    const result = await query<{ title: string }>(
      `SELECT DISTINCT title
       FROM products
       WHERE is_active = true
         AND title ILIKE $1
       LIMIT 10`,
      [`%${q}%`]
    );

    const suggestions = result.rows.map(row => row.title);

    res.json({ suggestions });
  } catch (error) {
    next(error);
  }
});

// Fallback search using PostgreSQL full-text search
async function fallbackSearch(
  queryText: string,
  filters: FallbackFilters,
  page: number,
  limit: number
): Promise<FallbackSearchResult> {
  let whereClause = 'WHERE p.is_active = true';
  const params: unknown[] = [];

  if (queryText) {
    params.push(queryText);
    whereClause += ` AND to_tsvector('english', p.title || ' ' || COALESCE(p.description, '')) @@ plainto_tsquery('english', $${params.length})`;
  }

  if (filters.category) {
    params.push(filters.category);
    whereClause += ` AND c.slug = $${params.length}`;
  }

  if (filters.minPrice) {
    params.push(parseFloat(filters.minPrice));
    whereClause += ` AND p.price >= $${params.length}`;
  }

  if (filters.maxPrice) {
    params.push(parseFloat(filters.maxPrice));
    whereClause += ` AND p.price <= $${params.length}`;
  }

  let orderBy = 'p.created_at DESC';
  switch (filters.sortBy) {
    case 'price_asc':
      orderBy = 'p.price ASC';
      break;
    case 'price_desc':
      orderBy = 'p.price DESC';
      break;
    case 'rating':
      orderBy = 'p.rating DESC NULLS LAST';
      break;
  }

  const offset = page * limit;

  const result = await query<ProductRow>(
    `SELECT p.id, p.title, p.slug, p.description, p.price, p.compare_at_price,
            p.images, p.rating, p.review_count,
            c.name as category_name, c.slug as category_slug,
            COALESCE(SUM(i.quantity - i.reserved), 0) as stock_quantity
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     LEFT JOIN inventory i ON p.id = i.product_id
     ${whereClause}
     ${filters.inStock ? 'HAVING COALESCE(SUM(i.quantity - i.reserved), 0) > 0' : ''}
     GROUP BY p.id, c.name, c.slug
     ORDER BY ${orderBy}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countResult = await query<{ total: string }>(
    `SELECT COUNT(DISTINCT p.id) as total
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     ${whereClause}`,
    params
  );

  return {
    products: result.rows,
    total: parseInt(countResult.rows[0]?.total || '0'),
    aggregations: {},
    page,
    limit
  };
}

export default router;
