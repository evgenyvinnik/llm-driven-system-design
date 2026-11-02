import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';

const router = Router();

// GET /api/users/search?q=term
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const q = req.query.q;

    if (typeof q !== 'string' || q.length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    // Used to find people to add to a project. Emails are matched exactly and never
    // returned, so the endpoint can't be used to harvest every account's address.
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const result = await pool.query(
      `SELECT id, username, display_name
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1 OR lower(email) = lower($3))
         AND id != $2
       ORDER BY username
       LIMIT 10`,
      [pattern, req.session.userId, q],
    );

    const users = result.rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
    }));

    res.json({ users });
  } catch (err) {
    logger.error({ err }, 'User search failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Users router providing search by username, email, or display name. */
export default router;
