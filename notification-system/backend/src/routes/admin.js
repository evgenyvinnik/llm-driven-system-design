import { Router } from 'express';
import { query } from '../utils/database.js';
import { redis } from '../utils/redis.js';
import { adminMiddleware } from '../middleware/auth.js';
import { deliveryTracker } from '../services/delivery.js';
import { rateLimiter } from '../services/rateLimiter.js';

const router = Router();

// All admin routes require admin role
router.use(adminMiddleware);

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const timeRange = req.query.timeRange || '24 hours';

    // Get various stats in parallel
    const [
      notificationStats,
      deliveryStats,
      userStats,
      queueDepth,
    ] = await Promise.all([
      // Total notifications
      query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
           COUNT(*) FILTER (WHERE status = 'pending') as pending,
           COUNT(*) FILTER (WHERE status = 'failed') as failed
         FROM notifications
         WHERE created_at >= NOW() - $1::interval`,
        [timeRange]
      ),

      // Delivery stats by channel
      deliveryTracker.getDeliveryStats(timeRange),

      // User stats
      query(
        `SELECT
           COUNT(*) as total_users,
           COUNT(*) FILTER (WHERE created_at >= NOW() - $1::interval) as new_users
         FROM users`,
        [timeRange]
      ),

      // Queue depth from Redis
      getQueueDepth(),
    ]);

    res.json({
      notifications: notificationStats.rows[0],
      deliveryByChannel: deliveryStats,
      users: userStats.rows[0],
      queueDepth,
      timeRange,
    });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const { limit = 50, offset = 0, role } = req.query;

    let queryStr = `SELECT id, email, name, phone, role, email_verified, phone_verified, created_at FROM users`;
    const params = [];

    if (role) {
      params.push(role);
      queryStr += ` WHERE role = $${params.length}`;
    }

    queryStr += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await query(queryStr, params);
    res.json({ users: result.rows });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Get user by ID
router.get('/users/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT u.*, np.channels, np.categories, np.quiet_hours_start, np.quiet_hours_end, np.timezone
       FROM users u
       LEFT JOIN notification_preferences np ON u.id = np.user_id
       WHERE u.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Get rate limit usage
    const rateLimitUsage = await rateLimiter.getUsage(user.id);

    // Get recent notifications count
    const notificationCount = await query(
      `SELECT COUNT(*) as count FROM notifications WHERE user_id = $1`,
      [user.id]
    );

    res.json({
      ...user,
      rateLimitUsage,
      notificationCount: parseInt(notificationCount.rows[0].count),
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Update user role
router.patch('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const result = await query(
      `UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, name, role`,
      [req.params.id, role]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Reset user rate limits
router.post('/users/:id/reset-rate-limit', async (req, res) => {
  try {
    await rateLimiter.resetUserLimit(req.params.id);
    res.json({ message: 'Rate limits reset' });
  } catch (error) {
    console.error('Reset rate limit error:', error);
    res.status(500).json({ error: 'Failed to reset rate limits' });
  }
});

// Get notification analytics
router.get('/analytics/notifications', async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const result = await query(
      `SELECT
         DATE(created_at) as date,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE status = 'failed') as failed
       FROM notifications
       WHERE created_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [parseInt(days)]
    );

    res.json({ analytics: result.rows });
  } catch (error) {
    console.error('Get notification analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Get event analytics (opens, clicks)
router.get('/analytics/events', async (req, res) => {
  try {
    const { days = 7 } = req.query;

    const result = await query(
      `SELECT
         DATE(occurred_at) as date,
         event_type,
         channel,
         COUNT(*) as count
       FROM notification_events
       WHERE occurred_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY DATE(occurred_at), event_type, channel
       ORDER BY date DESC`,
      [parseInt(days)]
    );

    res.json({ analytics: result.rows });
  } catch (error) {
    console.error('Get event analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Get failed notifications for retry
router.get('/failed-notifications', async (req, res) => {
  try {
    const result = await query(
      `SELECT n.*, ds.channel, ds.details, ds.attempts
       FROM notifications n
       JOIN delivery_status ds ON n.id = ds.notification_id
       WHERE ds.status = 'failed'
       ORDER BY n.created_at DESC
       LIMIT 100`
    );

    res.json({ notifications: result.rows });
  } catch (error) {
    console.error('Get failed notifications error:', error);
    res.status(500).json({ error: 'Failed to get failed notifications' });
  }
});

// Helper function to get queue depth
async function getQueueDepth() {
  const channels = ['push', 'email', 'sms'];
  const priorities = ['critical', 'high', 'normal', 'low'];
  const depth = {};

  for (const channel of channels) {
    depth[channel] = {};
    for (const priority of priorities) {
      const key = `queue:${channel}:${priority}`;
      const count = await redis.llen(key);
      depth[channel][priority] = count;
    }
  }

  return depth;
}

export default router;
