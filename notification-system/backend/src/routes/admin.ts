import { Router, Request, Response } from 'express';
import { query } from '../utils/database.js';
import { redis } from '../utils/redis.js';
import { adminMiddleware } from '../middleware/auth.js';
import { deliveryTracker } from '../services/delivery.js';
import { rateLimiter } from '../services/rateLimiter.js';
import { getOutboxLagSeconds } from '../services/outbox.js';

const router: Router = Router();

interface NotificationStatsRow {
  total: string;
  delivered: string;
  pending: string;
  failed: string;
}

interface UserStatsRow {
  total_users: string;
  new_users: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: string;
  email_verified: boolean;
  phone_verified: boolean;
  created_at: Date;
  channels?: Record<string, unknown>;
  categories?: Record<string, unknown>;
  quiet_hours_start?: number | null;
  quiet_hours_end?: number | null;
  timezone?: string;
}

interface AnalyticsRow {
  date: string;
  total: string;
  delivered: string;
  failed: string;
}

interface EventAnalyticsRow {
  date: string;
  event_type: string;
  channel: string;
  count: string;
}

interface FailedNotificationRow {
  id: string;
  user_id: string;
  channel: string;
  details: Record<string, unknown>;
  attempts: number;
  [key: string]: unknown;
}

// All admin routes require admin role
router.use(adminMiddleware);

// Dashboard stats
router.get('/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    const timeRange = (req.query.timeRange as string) || '24 hours';

    // Get various stats in parallel
    const [
      notificationStats,
      deliveryStats,
      userStats,
      queueDepth,
    ] = await Promise.all([
      // Total notifications
      query<NotificationStatsRow>(
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
      query<UserStatsRow>(
        `SELECT
           COUNT(*) as total_users,
           COUNT(*) FILTER (WHERE created_at >= NOW() - $1::interval) as new_users
         FROM users`,
        [timeRange]
      ),

      // Deliveries waiting or in flight, by channel and priority
      deliveryTracker.getBacklog(),
    ]);
    const outboxLagSeconds = await getOutboxLagSeconds();

    res.json({
      notifications: notificationStats.rows[0],
      deliveryByChannel: deliveryStats,
      users: userStats.rows[0],
      queueDepth,
      outboxLagSeconds,
      timeRange,
    });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get all users
router.get('/users', async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = '50', offset = '0', role } = req.query;

    let queryStr = `SELECT id, email, name, phone, role, email_verified, phone_verified, created_at FROM users`;
    const params: unknown[] = [];

    if (role) {
      params.push(role);
      queryStr += ` WHERE role = $${params.length}`;
    }

    queryStr += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await query<UserRow>(queryStr, params);
    res.json({ users: result.rows });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Get user by ID
router.get('/users/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<UserRow>(
      `SELECT u.*, np.channels, np.categories, np.quiet_hours_start, np.quiet_hours_end, np.timezone
       FROM users u
       LEFT JOIN notification_preferences np ON u.id = np.user_id
       WHERE u.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0];

    // Get rate limit usage
    const rateLimitUsage = await rateLimiter.getUsage(user.id);

    // Get recent notifications count
    const notificationCount = await query<{ count: string }>(
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
router.patch('/users/:id/role', async (req: Request, res: Response): Promise<void> => {
  try {
    const { role } = req.body as { role: string };

    if (!['user', 'admin'].includes(role)) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }

    const result = await query<{ id: string; email: string; name: string; role: string }>(
      `UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, name, role`,
      [req.params.id, role]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Sessions cache the role in Redis for up to 24 hours. Evict them so a
    // demotion takes effect on the next request instead of a day later; the
    // auth middleware then reloads the role from PostgreSQL.
    const sessions = await query<{ token: string }>(
      `SELECT token FROM sessions WHERE user_id = $1`,
      [req.params.id]
    );
    if (sessions.rows.length > 0) {
      await redis.del(...sessions.rows.map((row) => `session:${row.token}`));
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Reset user rate limits
router.post('/users/:id/reset-rate-limit', async (req: Request, res: Response): Promise<void> => {
  try {
    await rateLimiter.resetUserLimit(req.params.id as string);
    res.json({ message: 'Rate limits reset' });
  } catch (error) {
    console.error('Reset rate limit error:', error);
    res.status(500).json({ error: 'Failed to reset rate limits' });
  }
});

// Get notification analytics
router.get('/analytics/notifications', async (req: Request, res: Response): Promise<void> => {
  try {
    const { days = '7' } = req.query;

    const result = await query<AnalyticsRow>(
      `SELECT
         DATE(created_at) as date,
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
         COUNT(*) FILTER (WHERE status = 'failed') as failed
       FROM notifications
       WHERE created_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [parseInt(days as string)]
    );

    res.json({ analytics: result.rows });
  } catch (error) {
    console.error('Get notification analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Get event analytics (opens, clicks)
router.get('/analytics/events', async (req: Request, res: Response): Promise<void> => {
  try {
    const { days = '7' } = req.query;

    const result = await query<EventAnalyticsRow>(
      `SELECT
         DATE(occurred_at) as date,
         event_type,
         channel,
         COUNT(*) as count
       FROM notification_events
       WHERE occurred_at >= NOW() - INTERVAL '1 day' * $1
       GROUP BY DATE(occurred_at), event_type, channel
       ORDER BY date DESC`,
      [parseInt(days as string)]
    );

    res.json({ analytics: result.rows });
  } catch (error) {
    console.error('Get event analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Get failed notifications for retry
router.get('/failed-notifications', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<FailedNotificationRow>(
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

export default router;
