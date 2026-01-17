import express from 'express';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';
import { db } from '../config/database.js';
import { aggregationService } from '../services/aggregationService.js';

const router = express.Router();

// All admin routes require authentication and admin role
router.use(authMiddleware, adminMiddleware);

// Get system stats
router.get('/stats', async (req, res) => {
  try {
    const [users, samples, aggregates, insights, devices] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM users'),
      db.query('SELECT COUNT(*) as count FROM health_samples'),
      db.query('SELECT COUNT(*) as count FROM health_aggregates'),
      db.query('SELECT COUNT(*) as count FROM health_insights'),
      db.query('SELECT COUNT(*) as count FROM user_devices')
    ]);

    // Get samples by type
    const samplesByType = await db.query(
      `SELECT type, COUNT(*) as count
       FROM health_samples
       GROUP BY type
       ORDER BY count DESC
       LIMIT 10`
    );

    // Get recent activity
    const recentActivity = await db.query(
      `SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as count
       FROM health_samples
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY hour
       ORDER BY hour`
    );

    res.json({
      totals: {
        users: parseInt(users.rows[0].count),
        samples: parseInt(samples.rows[0].count),
        aggregates: parseInt(aggregates.rows[0].count),
        insights: parseInt(insights.rows[0].count),
        devices: parseInt(devices.rows[0].count)
      },
      samplesByType: samplesByType.rows,
      recentActivity: recentActivity.rows
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.created_at,
              COUNT(DISTINCT d.id) as device_count,
              COUNT(DISTINCT hs.type) as metric_types
       FROM users u
       LEFT JOIN user_devices d ON u.id = d.user_id
       LEFT JOIN health_samples hs ON u.id = hs.user_id
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Get user details
router.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await db.query(
      `SELECT id, email, name, role, created_at FROM users WHERE id = $1`,
      [userId]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [devices, sampleCounts, recentInsights] = await Promise.all([
      db.query('SELECT * FROM user_devices WHERE user_id = $1', [userId]),
      db.query(
        `SELECT type, COUNT(*) as count
         FROM health_samples WHERE user_id = $1 GROUP BY type`,
        [userId]
      ),
      db.query(
        `SELECT * FROM health_insights
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 5`,
        [userId]
      )
    ]);

    res.json({
      user: user.rows[0],
      devices: devices.rows,
      sampleCounts: sampleCounts.rows,
      recentInsights: recentInsights.rows
    });
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({ error: 'Failed to get user details' });
  }
});

// Trigger re-aggregation for a user
router.post('/users/:userId/reaggregate', async (req, res) => {
  try {
    const { userId } = req.params;
    const { startDate, endDate } = req.body;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    await aggregationService.reaggregateUser(userId, start, end);

    res.json({ message: 'Re-aggregation complete' });
  } catch (error) {
    console.error('Reaggregate error:', error);
    res.status(500).json({ error: 'Failed to re-aggregate' });
  }
});

// Get health data types configuration
router.get('/config/types', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM health_data_types ORDER BY category, type');
    res.json({ types: result.rows });
  } catch (error) {
    console.error('Get types config error:', error);
    res.status(500).json({ error: 'Failed to get types config' });
  }
});

export default router;
