import { Router } from 'express';
import { query } from '../services/database.js';
import { requireAdmin } from '../middleware/auth.js';
import { bulkIndexProducts } from '../services/elasticsearch.js';

const router = Router();

// All routes require admin
router.use(requireAdmin);

// Dashboard stats
router.get('/stats', async (req, res, next) => {
  try {
    const [
      productsResult,
      ordersResult,
      usersResult,
      revenueResult,
      recentOrdersResult,
      lowStockResult
    ] = await Promise.all([
      query('SELECT COUNT(*) as total FROM products WHERE is_active = true'),
      query('SELECT COUNT(*) as total, status FROM orders GROUP BY status'),
      query('SELECT COUNT(*) as total FROM users'),
      query(`
        SELECT COALESCE(SUM(total), 0) as total_revenue,
               COUNT(*) as order_count
        FROM orders
        WHERE status NOT IN ('cancelled', 'refunded')
          AND created_at >= NOW() - INTERVAL '30 days'
      `),
      query(`
        SELECT o.id, o.total, o.status, o.created_at, u.name as user_name
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        ORDER BY o.created_at DESC
        LIMIT 10
      `),
      query(`
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
    const ordersByStatus = {};
    ordersResult.rows.forEach(row => {
      ordersByStatus[row.status] = parseInt(row.total);
    });

    res.json({
      products: parseInt(productsResult.rows[0].total),
      orders: ordersByStatus,
      users: parseInt(usersResult.rows[0].total),
      revenue: {
        last30Days: parseFloat(revenueResult.rows[0].total_revenue),
        orderCount: parseInt(revenueResult.rows[0].order_count)
      },
      recentOrders: recentOrdersResult.rows,
      lowStockProducts: lowStockResult.rows
    });
  } catch (error) {
    next(error);
  }
});

// List all orders
router.get('/orders', async (req, res, next) => {
  try {
    const { status, page = 0, limit = 20 } = req.query;

    let whereClause = '';
    const params = [];

    if (status) {
      params.push(status);
      whereClause = 'WHERE o.status = $1';
    }

    const offset = parseInt(page) * parseInt(limit);

    const result = await query(
      `SELECT o.*, u.name as user_name, u.email as user_email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    const countResult = await query(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`,
      params
    );

    res.json({
      orders: result.rows,
      total: parseInt(countResult.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    next(error);
  }
});

// List all users
router.get('/users', async (req, res, next) => {
  try {
    const { role, page = 0, limit = 20 } = req.query;

    let whereClause = '';
    const params = [];

    if (role) {
      params.push(role);
      whereClause = 'WHERE role = $1';
    }

    const offset = parseInt(page) * parseInt(limit);

    const result = await query(
      `SELECT id, email, name, role, created_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    const countResult = await query(
      `SELECT COUNT(*) as total FROM users ${whereClause}`,
      params
    );

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].total),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    next(error);
  }
});

// Update user role
router.put('/users/:id/role', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['user', 'admin', 'seller'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const result = await query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, name, role`,
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// Sync products to Elasticsearch
router.post('/sync-elasticsearch', async (req, res, next) => {
  try {
    const result = await query(
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

    await bulkIndexProducts(result.rows);

    res.json({ message: `Indexed ${result.rows.length} products` });
  } catch (error) {
    next(error);
  }
});

// Inventory report
router.get('/inventory', async (req, res, next) => {
  try {
    const { lowStock } = req.query;

    let havingClause = '';
    if (lowStock === 'true') {
      havingClause = 'HAVING COALESCE(SUM(i.quantity - i.reserved), 0) < COALESCE(MIN(i.low_stock_threshold), 10)';
    }

    const result = await query(
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
