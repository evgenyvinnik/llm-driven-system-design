import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../services/database.js';
import { requireAdmin } from '../middleware/auth.js';
import { bulkIndexProducts } from '../services/elasticsearch.js';

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
  category_id?: number;
  category_name?: string;
  category_slug?: string;
  seller_id?: number;
  seller_name?: string;
  stock_quantity?: string;
}

interface OrderRow {
  id: number;
  total: string;
  status: string;
  created_at: Date;
  user_name?: string;
  user_email?: string;
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  created_at: Date;
}

interface InventoryRow {
  id: number;
  title: string;
  slug: string;
  total_quantity: string;
  reserved: string;
  available: string;
  low_stock_threshold: string;
}

// All routes require admin
router.use(requireAdmin);

// Dashboard stats
router.get('/stats', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [
      productsResult,
      ordersResult,
      usersResult,
      revenueResult,
      recentOrdersResult,
      lowStockResult
    ] = await Promise.all([
      query<{ total: string }>('SELECT COUNT(*) as total FROM products WHERE is_active = true'),
      query<{ total: string; status: string }>('SELECT COUNT(*) as total, status FROM orders GROUP BY status'),
      query<{ total: string }>('SELECT COUNT(*) as total FROM users'),
      query<{ total_revenue: string; order_count: string }>(`
        SELECT COALESCE(SUM(total), 0) as total_revenue,
               COUNT(*) as order_count
        FROM orders
        WHERE status NOT IN ('cancelled', 'refunded')
          AND created_at >= NOW() - INTERVAL '30 days'
      `),
      query<OrderRow>(`
        SELECT o.id, o.total, o.status, o.created_at, u.name as user_name
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        ORDER BY o.created_at DESC
        LIMIT 10
      `),
      query<{ id: number; title: string; slug: string; stock: string }>(`
        SELECT p.id, p.title, p.slug, COALESCE(SUM(i.quantity - i.reserved), 0) as stock
        FROM products p
        LEFT JOIN inventory i ON p.id = i.product_id
        WHERE p.is_active = true
        GROUP BY p.id
        HAVING COALESCE(SUM(i.quantity - i.reserved), 0) < 10
        ORDER BY stock ASC
        LIMIT 10
      `)
    ]);

    // Calculate order stats by status
    const ordersByStatus: Record<string, number> = {};
    ordersResult.rows.forEach(row => {
      ordersByStatus[row.status] = parseInt(row.total);
    });

    res.json({
      products: parseInt(productsResult.rows[0]?.total || '0'),
      orders: ordersByStatus,
      users: parseInt(usersResult.rows[0]?.total || '0'),
      revenue: {
        last30Days: parseFloat(revenueResult.rows[0]?.total_revenue || '0'),
        orderCount: parseInt(revenueResult.rows[0]?.order_count || '0')
      },
      recentOrders: recentOrdersResult.rows,
      lowStockProducts: lowStockResult.rows
    });
  } catch (error) {
    next(error);
  }
});

// List all orders
router.get('/orders', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { status, page = 0, limit = 20 } = req.query;

    let whereClause = '';
    const params: unknown[] = [];

    if (status) {
      params.push(status);
      whereClause = 'WHERE o.status = $1';
    }

    const offset = parseInt(String(page)) * parseInt(String(limit));

    const result = await query<OrderRow>(
      `SELECT o.*, u.name as user_name, u.email as user_email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(String(limit)), offset]
    );

    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`,
      params
    );

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0]?.total || '0'),
      page: parseInt(String(page)),
      limit: parseInt(String(limit))
    });
  } catch (error) {
    next(error);
  }
});

// List all users
router.get('/users', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { role, page = 0, limit = 20 } = req.query;

    let whereClause = '';
    const params: unknown[] = [];

    if (role) {
      params.push(role);
      whereClause = 'WHERE role = $1';
    }

    const offset = parseInt(String(page)) * parseInt(String(limit));

    const result = await query<UserRow>(
      `SELECT id, email, name, role, created_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(String(limit)), offset]
    );

    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM users ${whereClause}`,
      params
    );

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0]?.total || '0'),
      page: parseInt(String(page)),
      limit: parseInt(String(limit))
    });
  } catch (error) {
    next(error);
  }
});

// Update user role
router.put('/users/:id/role', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['user', 'admin', 'seller'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }

    const result = await query<UserRow>(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, role`,
      [role, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Sync products to Elasticsearch
router.post('/sync-elasticsearch', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await query<ProductRow>(
      `SELECT p.*, c.name as category_name, c.slug as category_slug,
              s.business_name as seller_name,
              COALESCE(SUM(i.quantity - i.reserved), 0) as stock_quantity
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN sellers s ON p.seller_id = s.id
       LEFT JOIN inventory i ON p.id = i.product_id
       WHERE p.is_active = true
       GROUP BY p.id, c.name, c.slug, s.business_name`
    );

    await bulkIndexProducts(result.rows.map(row => ({
      ...row,
      id: row.id,
      title: row.title,
      price: row.price,
      stock_quantity: parseInt(row.stock_quantity || '0')
    })));

    res.json({ message: `Indexed ${result.rows.length} products` });
  } catch (error) {
    next(error);
  }
});

// Inventory report
router.get('/inventory', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { lowStock } = req.query;

    let havingClause = '';
    if (lowStock === 'true') {
      havingClause = 'HAVING COALESCE(SUM(i.quantity - i.reserved), 0) < COALESCE(MIN(i.low_stock_threshold), 10)';
    }

    const result = await query<InventoryRow>(
      `SELECT p.id, p.title, p.slug,
              COALESCE(SUM(i.quantity), 0) as total_quantity,
              COALESCE(SUM(i.reserved), 0) as reserved,
              COALESCE(SUM(i.quantity - i.reserved), 0) as available,
              COALESCE(MIN(i.low_stock_threshold), 10) as low_stock_threshold
       FROM products p
       LEFT JOIN inventory i ON p.id = i.product_id
       WHERE p.is_active = true
       GROUP BY p.id
       ${havingClause}
       ORDER BY available ASC`
    );

    res.json({ inventory: result.rows });
  } catch (error) {
    next(error);
  }
});

export default router;
