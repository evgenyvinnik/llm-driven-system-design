import express, { Request, Response, NextFunction, Router } from 'express';
import bcrypt from 'bcrypt';
import pool from '../db/pool.js';

const router: Router = express.Router();

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required' });
      return;
    }

    if (username.length < 3 || username.length > 50) {
      res.status(400).json({ error: 'Username must be between 3 and 50 characters' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const existingUser = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, bio, avatar_url, follower_count, following_count, tweet_count, created_at`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash, displayName || username]
    );

    const user = result.rows[0];

    req.session.userId = user.id;
    req.session.role = 'user';

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        tweetCount: user.tweet_count,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const result = await pool.query(
      `SELECT id, username, email, password_hash, display_name, bio, avatar_url,
              follower_count, following_count, tweet_count, role, created_at
       FROM users WHERE username = $1`,
      [username.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    req.session.userId = user.id;
    req.session.role = user.role;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        tweetCount: user.tweet_count,
        role: user.role,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Failed to logout' });
      return;
    }
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// GET /api/auth/me
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.session || !req.session.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await pool.query(
      `SELECT id, username, email, display_name, bio, avatar_url,
              follower_count, following_count, tweet_count, role, created_at
       FROM users WHERE id = $1`,
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      req.session.destroy(() => {});
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        tweetCount: user.tweet_count,
        role: user.role,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
