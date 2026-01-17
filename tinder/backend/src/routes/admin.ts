import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { UserService } from '../services/userService.js';
import { MatchService } from '../services/matchService.js';
import { MessageService } from '../services/messageService.js';
import { pool } from '../db/index.js';

const router = Router();
const userService = new UserService();
const matchService = new MatchService();
const messageService = new MessageService();

// Middleware to check admin status
async function requireAdmin(req: Request, res: Response, next: () => void) {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await userService.getUserById(req.session.userId);
  if (!user || !user.is_admin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}

// Get dashboard stats
router.get('/stats', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [userStats, matchStats, messageStats, activeStats] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') as new_users_today,
          COUNT(*) FILTER (WHERE last_active >= NOW() - INTERVAL '1 day') as active_today,
          COUNT(*) FILTER (WHERE gender = 'male') as male_count,
          COUNT(*) FILTER (WHERE gender = 'female') as female_count
        FROM users
      `),
      matchService.getMatchStats(),
      messageService.getMessageStats(),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE last_active >= NOW() - INTERVAL '5 minutes') as online_now,
          COUNT(*) FILTER (WHERE last_active >= NOW() - INTERVAL '1 hour') as active_hour
        FROM users
      `),
    ]);

    res.json({
      users: {
        total: parseInt(userStats.rows[0].total_users),
        newToday: parseInt(userStats.rows[0].new_users_today),
        activeToday: parseInt(userStats.rows[0].active_today),
        maleCount: parseInt(userStats.rows[0].male_count),
        femaleCount: parseInt(userStats.rows[0].female_count),
        onlineNow: parseInt(activeStats.rows[0].online_now),
        activeLastHour: parseInt(activeStats.rows[0].active_hour),
      },
      matches: matchStats,
      messages: messageStats,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get all users
router.get('/users', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const { users, total } = await userService.getAllUsers(limit, offset);

    // Don't expose password hashes
    const safeUsers = users.map(({ password_hash, ...user }) => user);

    res.json({
      users: safeUsers,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Get user details
router.get('/users/:userId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const profile = await userService.getUserProfile(req.params.userId);
    if (!profile) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { password_hash, ...safeProfile } = profile;
    res.json(safeProfile);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Ban/suspend user
router.post('/users/:userId/ban', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    // For demo, we'll just set show_me to false
    await pool.query(
      'UPDATE user_preferences SET show_me = false WHERE user_id = $1',
      [userId]
    );

    res.json({ message: 'User banned' });
  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// Unban user
router.post('/users/:userId/unban', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    await pool.query(
      'UPDATE user_preferences SET show_me = true WHERE user_id = $1',
      [userId]
    );

    res.json({ message: 'User unbanned' });
  } catch (error) {
    console.error('Unban user error:', error);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// Delete user
router.delete('/users/:userId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    // Don't allow deleting yourself
    if (userId === req.session.userId) {
      res.status(400).json({ error: 'Cannot delete yourself' });
      return;
    }

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    res.json({ message: 'User deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Get recent activity
router.get('/activity', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [recentMatches, recentSignups] = await Promise.all([
      pool.query(`
        SELECT m.id, m.matched_at,
          u1.name as user1_name, u2.name as user2_name
        FROM matches m
        JOIN users u1 ON m.user1_id = u1.id
        JOIN users u2 ON m.user2_id = u2.id
        ORDER BY m.matched_at DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT id, name, email, created_at, gender
        FROM users
        ORDER BY created_at DESC
        LIMIT 10
      `),
    ]);

    res.json({
      recentMatches: recentMatches.rows,
      recentSignups: recentSignups.rows,
    });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

export default router;
