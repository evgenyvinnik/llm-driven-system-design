import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../services/database.js';
import { cacheGet, cacheSet } from '../services/redis.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  parent_id?: number | null;
  parent_name?: string | null;
  parent_slug?: string | null;
  description?: string;
  image_url?: string;
  product_count?: string;
  children?: CategoryWithChildren[];
}

interface CategoryWithChildren extends CategoryRow {
  children: CategoryWithChildren[];
}

// List categories
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Try cache first
    const cacheKey = 'categories:all';
    let categories = await cacheGet<CategoryRow[]>(cacheKey);

    if (!categories) {
      const result = await query<CategoryRow>(
        `SELECT c.*,
                parent.name as parent_name,
                COUNT(p.id) as product_count
         FROM categories c
         LEFT JOIN categories parent ON c.parent_id = parent.id
         LEFT JOIN products p ON p.category_id = c.id AND p.is_active = true
         GROUP BY c.id, parent.name
         ORDER BY c.parent_id NULLS FIRST, c.name`
      );

      categories = result.rows;
      await cacheSet(cacheKey, categories, 3600); // Cache for 1 hour
    }

    // Build tree structure
    const categoryMap = new Map<number, CategoryWithChildren>();
    const rootCategories: CategoryWithChildren[] = [];

    categories.forEach(cat => {
      categoryMap.set(cat.id, { ...cat, children: [] });
    });

    categories.forEach(cat => {
      const category = categoryMap.get(cat.id);
      if (category) {
        if (cat.parent_id) {
          const parent = categoryMap.get(cat.parent_id);
          if (parent) {
            parent.children.push(category);
          }
        } else {
          rootCategories.push(category);
        }
      }
    });

    res.json({
      categories: rootCategories,
      flat: categories
    });
  } catch (error) {
    next(error);
  }
});

// Get single category
router.get('/:slug', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { slug } = req.params;

    const result = await query<CategoryRow>(
      `SELECT c.*, parent.name as parent_name, parent.slug as parent_slug
       FROM categories c
       LEFT JOIN categories parent ON c.parent_id = parent.id
       WHERE c.slug = $1`,
      [slug]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const category = result.rows[0];

    // Get subcategories
    const subcategories = await query<CategoryRow>(
      `SELECT id, name, slug, description, image_url
       FROM categories
       WHERE parent_id = $1
       ORDER BY name`,
      [category.id]
    );

    // Get breadcrumb path
    interface Breadcrumb {
      name: string;
      slug: string;
    }
    const breadcrumbs: Breadcrumb[] = [];
    let current: CategoryRow | null = category;
    while (current) {
      breadcrumbs.unshift({ name: current.name, slug: current.slug });
      if (current.parent_id) {
        const parent = await query<CategoryRow>(
          'SELECT id, name, slug, parent_id FROM categories WHERE id = $1',
          [current.parent_id]
        );
        current = parent.rows[0] || null;
      } else {
        current = null;
      }
    }

    res.json({
      category,
      subcategories: subcategories.rows,
      breadcrumbs
    });
  } catch (error) {
    next(error);
  }
});

// Create category (admin only)
router.post('/', requireAdmin, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, slug, parentId, description, imageUrl } = req.body;

    const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const result = await query<CategoryRow>(
      `INSERT INTO categories (name, slug, parent_id, description, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, finalSlug, parentId, description, imageUrl]
    );

    res.status(201).json({ category: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Update category (admin only)
router.put('/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, slug, parentId, description, imageUrl } = req.body;

    const result = await query<CategoryRow>(
      `UPDATE categories
       SET name = COALESCE($1, name),
           slug = COALESCE($2, slug),
           parent_id = COALESCE($3, parent_id),
           description = COALESCE($4, description),
           image_url = COALESCE($5, image_url)
       WHERE id = $6
       RETURNING *`,
      [name, slug, parentId, description, imageUrl, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    res.json({ category: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Delete category (admin only)
router.delete('/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;

    await query('DELETE FROM categories WHERE id = $1', [id]);

    res.json({ message: 'Category deleted' });
  } catch (error) {
    next(error);
  }
});

export default router;
