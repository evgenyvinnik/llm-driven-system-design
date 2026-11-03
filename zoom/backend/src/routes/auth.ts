import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../services/db.js';
import { logger } from '../services/logger.js';
import { authLimiter } from '../services/rateLimiter.js';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;

/**
 * Issues a fresh session id at login: keeping the pre-login id would let anyone
 * who planted or observed it (session fixation) ride the authenticated session.
 */
function startSession(req: Request, userId: string, username: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.username = username;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

function toUserDto(row: { id: string; username: string; email: string; display_name: string | null; created_at: string }) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name || row.username,
    createdAt: row.created_at,
  };
}

router.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }
    // Bound every field to its column so bad input is a 400, not a database error.
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      res.status(400).json({ error: 'Username must be 3-30 letters, digits, dots, dashes or underscores' });
      return;
    }
    if (typeof email !== 'string' || email.length > 255 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'A valid email is required' });
      return;
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      res.status(400).json({ error: 'Password must be 8-200 characters' });
      return;
    }
    if (displayName !== undefined && displayName !== null && (typeof displayName !== 'string' || displayName.length > 100)) {
      res.status(400).json({ error: 'Display name must be at most 100 characters' });
      return;
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4) RETURNING id, username, email, display_name, created_at`,
      [username, email, passwordHash, (typeof displayName === 'string' && displayName.trim()) || username]
    );

    const user = result.rows[0];
    await startSession(req, user.id, user.username);

    logger.info({ userId: user.id, username }, 'User registered');
    // camelCase like /login and /me: the raw row's display_name left the
    // client's displayName undefined until the next page load.
    res.status(201).json({ user: toUserDto(user) });
  } catch (err) {
    // Two registrations racing past the existence check hit the unique index.
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }
    logger.error({ err }, 'Registration error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const result = await pool.query(
      'SELECT id, username, email, display_name, password_hash, created_at FROM users WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    await startSession(req, user.id, user.username);

    logger.info({ userId: user.id, username }, 'User logged in');
    res.json({ user: toUserDto(user) });
  } catch (err) {
    logger.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      logger.error({ err }, 'Logout error');
      res.status(500).json({ error: 'Logout failed' });
      return;
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

router.get('/me', (req: Request, res: Response) => {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  pool
    .query('SELECT id, username, email, display_name, avatar_url, created_at FROM users WHERE id = $1', [
      req.session.userId,
    ])
    .then((result) => {
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      const user = result.rows[0];
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          avatarUrl: user.avatar_url,
          createdAt: user.created_at,
        },
      });
    })
    .catch((err) => {
      logger.error({ err }, 'Get user error');
      res.status(500).json({ error: 'Internal server error' });
    });
});

export default router;
