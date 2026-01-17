import { Router } from 'express';
import type { Request, Response } from 'express';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { getOrderStats, getRecentOrders } from '../services/orderService.js';
import { query, queryOne } from '../utils/db.js';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate, requireAdmin);

// Get dashboard stats
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const orderStats = await getOrderStats();

    const driverStats = await queryOne<{
      total: string;
      online: string;
      busy: string;
    }>(`
      SELECT
        COUNT(*)::text as total,
        COUNT(*) FILTER (WHERE status = 'available')::text as online,
        COUNT(*) FILTER (WHERE status = 'busy')::text as busy
      FROM drivers
    `);

    const merchantStats = await queryOne<{
      total: string;
      open: string;
    }>(`
      SELECT
        COUNT(*)::text as total,
        COUNT(*) FILTER (WHERE is_open = true)::text as open
      FROM merchants
    `);

    const customerStats = await queryOne<{
      total: string;
      active_today: string;
    }>(`
      SELECT
        COUNT(*)::text as total,
        COUNT(DISTINCT o.customer_id)::text as active_today
      FROM users u
      LEFT JOIN orders o ON u.id = o.customer_id AND DATE(o.created_at) = CURRENT_DATE
      WHERE u.role = 'customer'
    `);

    res.json({
      success: true,
      data: {
        orders: orderStats,
        drivers: {
          total: parseInt(driverStats?.total || '0'),
          online: parseInt(driverStats?.online || '0'),
          busy: parseInt(driverStats?.busy || '0'),
        },
        merchants: {
          total: parseInt(merchantStats?.total || '0'),
          open: parseInt(merchantStats?.open || '0'),
        },
        customers: {
          total: parseInt(customerStats?.total || '0'),
          active_today: parseInt(customerStats?.active_today || '0'),
        },
      },
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get stats',
    });
  }
});

// Get recent orders
router.get('/orders', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const orders = await getRecentOrders(limit);

    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get orders',
    });
  }
});

// Get all drivers
router.get('/drivers', async (req: Request, res: Response) => {
  try {
    const drivers = await query<{
      id: string;
      name: string;
      email: string;
      vehicle_type: string;
      status: string;
      rating: number;
      total_deliveries: number;
    }>(`
      SELECT d.id, u.name, u.email, d.vehicle_type, d.status, d.rating, d.total_deliveries
      FROM drivers d
      JOIN users u ON d.id = u.id
      ORDER BY d.total_deliveries DESC
    `);

    res.json({
      success: true,
      data: drivers,
    });
  } catch (error) {
    console.error('Get drivers error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get drivers',
    });
  }
});

// Get all merchants
router.get('/merchants', async (_req: Request, res: Response) => {
  try {
    const merchants = await query(`
      SELECT m.*, u.name as owner_name
      FROM merchants m
      LEFT JOIN users u ON m.owner_id = u.id
      ORDER BY m.rating DESC
    `);

    res.json({
      success: true,
      data: merchants,
    });
  } catch (error) {
    console.error('Get merchants error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get merchants',
    });
  }
});

// Get all customers
router.get('/customers', async (_req: Request, res: Response) => {
  try {
    const customers = await query(`
      SELECT u.id, u.name, u.email, u.phone, u.created_at,
             COUNT(o.id) as order_count,
             SUM(o.total) as total_spent
      FROM users u
      LEFT JOIN orders o ON u.id = o.customer_id
      WHERE u.role = 'customer'
      GROUP BY u.id
      ORDER BY order_count DESC
    `);

    res.json({
      success: true,
      data: customers,
    });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get customers',
    });
  }
});

// Get hourly order distribution
router.get('/analytics/hourly', async (_req: Request, res: Response) => {
  try {
    const hourlyData = await query<{ hour: number; count: string }>(`
      SELECT EXTRACT(HOUR FROM created_at)::int as hour, COUNT(*)::text as count
      FROM orders
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY hour
      ORDER BY hour
    `);

    res.json({
      success: true,
      data: hourlyData.map((h) => ({
        hour: h.hour,
        count: parseInt(h.count),
      })),
    });
  } catch (error) {
    console.error('Get hourly analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get analytics',
    });
  }
});

// Get daily order trends
router.get('/analytics/daily', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 7;

    const dailyData = await query<{
      date: string;
      total_orders: string;
      completed: string;
      cancelled: string;
      revenue: string;
    }>(`
      SELECT
        DATE(created_at)::text as date,
        COUNT(*)::text as total_orders,
        COUNT(*) FILTER (WHERE status = 'delivered')::text as completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')::text as cancelled,
        COALESCE(SUM(total) FILTER (WHERE status = 'delivered'), 0)::text as revenue
      FROM orders
      WHERE created_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    res.json({
      success: true,
      data: dailyData.map((d) => ({
        date: d.date,
        total_orders: parseInt(d.total_orders),
        completed: parseInt(d.completed),
        cancelled: parseInt(d.cancelled),
        revenue: parseFloat(d.revenue),
      })),
    });
  } catch (error) {
    console.error('Get daily analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get analytics',
    });
  }
});

export default router;
