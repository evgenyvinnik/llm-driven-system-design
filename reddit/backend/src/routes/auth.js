import express from 'express';
import {
  createUser,
  findUserByUsername,
  findUserById,
  verifyPassword,
  createSession,
  deleteSession,
} from '../models/user.js';
import { getUserSubscriptions } from '../models/subreddit.js';
import { listPostsByUser } from '../models/post.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../shared/logger.js';
import { auditLogin } from '../shared/audit.js';

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const user = await createUser(username, email, password);
    const sessionId = await createSession(user.id);

    // Audit successful registration (treated as login)
    await auditLogin(req, user.id, true);

    logger.info({ userId: user.id, username }, 'User registered');

    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        karma_post: user.karma_post,
        karma_comment: user.karma_comment,
        role: user.role,
      },
      sessionId,
    });
  } catch (error) {
    logger.error({ err: error }, 'Registration error');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await findUserByUsername(username);
    if (!user) {
      // Audit failed login attempt
      await auditLogin(req, null, false);
      logger.warn({ username }, 'Login failed - user not found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      // Audit failed login attempt
      await auditLogin(req, user.id, false);
      logger.warn({ userId: user.id, username }, 'Login failed - invalid password');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const sessionId = await createSession(user.id);

    // Audit successful login
    await auditLogin(req, user.id, true);

    logger.info({ userId: user.id, username }, 'User logged in');

    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        karma_post: user.karma_post,
        karma_comment: user.karma_comment,
        role: user.role,
      },
      sessionId,
    });
  } catch (error) {
    logger.error({ err: error }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const sessionId = req.cookies?.session || req.headers['x-session-id'];
    if (sessionId) {
      await deleteSession(sessionId);
    }

    logger.info({ userId: req.user.id }, 'User logged out');

    res.clearCookie('session');
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user
router.get('/me', async (req, res) => {
  if (!req.user) {
    return res.json({ user: null });
  }
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      karma_post: req.user.karma_post,
      karma_comment: req.user.karma_comment,
      role: req.user.role,
    },
  });
});

// Get user profile
router.get('/users/:username', async (req, res) => {
  try {
    const user = await findUserByUsername(req.params.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      id: user.id,
      username: user.username,
      karma_post: user.karma_post,
      karma_comment: user.karma_comment,
      created_at: user.created_at,
    });
  } catch (error) {
    logger.error({ err: error }, 'Get user error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's posts
router.get('/users/:username/posts', async (req, res) => {
  try {
    const user = await findUserByUsername(req.params.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const offset = parseInt(req.query.offset) || 0;

    const posts = await listPostsByUser(user.id, limit, offset);
    res.json(posts);
  } catch (error) {
    logger.error({ err: error }, 'Get user posts error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's subscriptions
router.get('/users/:username/subscriptions', async (req, res) => {
  try {
    const user = await findUserByUsername(req.params.username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const subscriptions = await getUserSubscriptions(user.id);
    res.json(subscriptions);
  } catch (error) {
    logger.error({ err: error }, 'Get subscriptions error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
