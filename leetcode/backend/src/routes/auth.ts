import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db/pool.js';
import { authRateLimiter } from '../shared/rateLimiter.js';
import { createModuleLogger } from '../shared/logger.js';

const router = Router();
const logger = createModuleLogger('auth');

interface RegisterBody {
  username?: string;
  email?: string;
  password?: string;
}

interface LoginBody {
  username?: string;
  password?: string;
}

// Register - rate limited to prevent abuse
router.post('/register', authRateLimiter, async (req: Request<unknown, unknown, RegisterBody>, res: Response): Promise<void> => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    // Check if user exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await pool.query(
      'INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [userId, username, email, passwordHash]
    );

    // Set session
    req.session.userId = userId;
    req.session.username = username;
    req.session.role = 'user';

    res.status(201).json({
      user: { id: userId, username, email, role: 'user' }
    });
  } catch (error) {
    logger.error({ error, username: req.body.username }, 'Registration failed');
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login - rate limited to prevent brute force attacks
router.post('/login', authRateLimiter, async (req: Request<unknown, unknown, LoginBody>, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const result = await pool.query(
      'SELECT id, username, email, password_hash, role FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    logger.error({ error, username: req.body.username }, 'Login failed');
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Logout failed' });
      return;
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
router.get('/me', (req: Request, res: Response): void => {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  res.json({
    user: {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role
    }
  });
});

export default router;
