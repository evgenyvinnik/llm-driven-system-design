import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { isUuid } from '../services/accessService.js';

const router = Router();

// GET /api/users/search?q=xxx - search users
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (typeof q !== 'string' || q.length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    // Escape LIKE wildcards so "%" or "_" match literally instead of
    // turning a two-character query into "list every user".
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url
       FROM users
       WHERE username ILIKE $1 OR display_name ILIKE $1
       ORDER BY username
       LIMIT 20`,
      [pattern],
    );

    res.json({ users: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to search users');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/users/:userId - get user profile
router.get('/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.userId)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const result = await pool.query(
      'SELECT id, username, email, display_name, avatar_url, role, created_at FROM users WHERE id = $1',
      [req.params.userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Any signed-in user can look up any profile (it's how people are found to
    // be added), so email and system role are only returned for yourself.
    const { email, role, ...profile } = result.rows[0];
    const isSelf = profile.id === req.session.userId;
    res.json({ user: isSelf ? { ...profile, email, role } : profile });
  } catch (err) {
    logger.error({ err }, 'Failed to get user');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
