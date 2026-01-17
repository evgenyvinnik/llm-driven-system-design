import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../../shared/db.js';

export const authRouter = Router();

// Middleware to require authentication
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

// Middleware to optionally attach user info
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  // Just pass through - user info will be available via session if logged in
  next();
}

// Register
authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    // Check if username or email already exists
    const existing = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query<{ id: string; username: string; email: string; display_name: string }>(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name`,
      [username, email, passwordHash, displayName || username]
    );

    const user = result.rows[0];

    // Set session
    req.session.userId = user.id;
    delete req.session.anonymousId;

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    // Find user
    const result = await query<{
      id: string;
      username: string;
      email: string;
      password_hash: string;
      display_name: string;
      is_developer: boolean;
    }>(
      'SELECT id, username, email, password_hash, display_name, is_developer FROM users WHERE username = $1 OR email = $1',
      [username]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];

    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Migrate anonymous installations to user account
    const anonymousId = req.session.anonymousId;
    if (anonymousId) {
      await query(
        `INSERT INTO user_plugins (user_id, plugin_id, version, enabled, settings, installed_at)
         SELECT $1, plugin_id, version, enabled, settings, installed_at
         FROM anonymous_installs
         WHERE session_id = $2
         ON CONFLICT (user_id, plugin_id) DO NOTHING`,
        [user.id, anonymousId]
      );
      await query('DELETE FROM anonymous_installs WHERE session_id = $1', [anonymousId]);
    }

    // Set session
    req.session.userId = user.id;
    delete req.session.anonymousId;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        isDeveloper: user.is_developer,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
authRouter.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out' });
  });
});

// Get current user
authRouter.get('/me', async (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.json({ user: null, isAnonymous: true, sessionId: req.session.anonymousId });
    return;
  }

  try {
    const result = await query<{
      id: string;
      username: string;
      email: string;
      display_name: string;
      is_developer: boolean;
    }>(
      'SELECT id, username, email, display_name, is_developer FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      req.session.destroy(() => {});
      res.json({ user: null, isAnonymous: true });
      return;
    }

    const user = result.rows[0];
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        isDeveloper: user.is_developer,
      },
      isAnonymous: false,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});
