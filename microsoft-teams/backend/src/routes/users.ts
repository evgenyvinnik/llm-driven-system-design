import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { isUuid } from '../services/access.js';

// Users are visible to each other only through a shared organization: the directory is per
// tenant, so nobody can enumerate or look up people in companies they do not belong to.
const SHARES_AN_ORG = `EXISTS (
  SELECT 1 FROM org_members mine
  JOIN org_members theirs ON theirs.org_id = mine.org_id
  WHERE mine.user_id = $1 AND theirs.user_id = u.id)`;

const router = Router();

// GET /api/users/search?q=xxx - search users who share an organization with the caller
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || (q as string).length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const pattern = `%${(q as string).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM users u
       WHERE (u.username ILIKE $2 OR u.display_name ILIKE $2) AND ${SHARES_AN_ORG}
       ORDER BY u.username
       LIMIT 20`,
      [req.session.userId, pattern],
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
    const result = isUuid(req.params.userId)
      ? await pool.query(
          `SELECT u.id, u.username, u.email, u.display_name, u.avatar_url, u.role, u.created_at
           FROM users u
           WHERE u.id = $2 AND (u.id = $1 OR ${SHARES_AN_ORG})`,
          [req.session.userId, req.params.userId],
        )
      : { rows: [] };

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get user');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
