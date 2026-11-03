import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../services/db.js';
import { sendError } from '../services/errors.js';

const router = Router();

/** Escapes LIKE wildcards so a query of "%" or "_" matches literally, not everyone. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// GET /api/users/search?q= - Search users to send money to
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      res.json({ users: [] });
      return;
    }
    const query = q.trim().slice(0, 100);

    // Names and usernames match by substring; email only by exact address, and
    // emails are never returned. Substring email matching plus an email field in
    // the response let any signed-in user list everyone's address. The platform
    // bookkeeping account is not a valid recipient and is excluded.
    const result = await pool.query(
      `SELECT id, username, display_name
       FROM users
       WHERE id != $1
         AND role <> 'system'
         AND (username ILIKE $2 OR display_name ILIKE $2 OR LOWER(email) = LOWER($3))
       ORDER BY username
       LIMIT 10`,
      [req.session.userId, `%${escapeLike(query)}%`, query],
    );

    const users = result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
    }));

    res.json({ users });
  } catch (err) {
    sendError(res, err, 'User search failed');
  }
});

/** Users router providing search by username, display name, or exact email. */
export default router;
