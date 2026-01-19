import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { requireAuth, ROLES } from '../middleware/auth.js';
import { createLogger, auditLog } from '../shared/logger.js';
import { getRateLimiters } from '../index.js';

const router = express.Router();
const logger = createLogger('auth');

// Helper to get rate limiters (lazy load since they're initialized after session setup)
const getLimiters = () => getRateLimiters();

// Register
router.post('/register', async (req, res, next) => {
  // Apply rate limiting
  const limiters = getLimiters();
  if (limiters?.register) {
    return limiters.register(req, res, async () => {
      await handleRegister(req, res, next);
    });
  }
  await handleRegister(req, res, next);
});

async function handleRegister(req, res, next) {
  try {
    const { username, email, password, displayName } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    // Validate password strength
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if user exists
    const existingUser = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      logger.warn({ username, email }, 'Registration attempt with existing username/email');
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user with 'user' role by default
    const result = await query(
      `INSERT INTO users (username, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, display_name, avatar_url, bio, follower_count, following_count, video_count, role, created_at`,
      [username, email, passwordHash, displayName || username, ROLES.USER]
    );

    const user = result.rows[0];

    // Create user embedding record
    await query(
      'INSERT INTO user_embeddings (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [user.id]
    );

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;

    // Audit log
    auditLog('user_registered', user.id, {
      username: user.username,
      email: user.email,
    });

    logger.info({ userId: user.id, username: user.username }, 'User registered successfully');

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        bio: user.bio,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        videoCount: user.video_count,
        role: user.role,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Registration error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Login
router.post('/login', async (req, res, next) => {
  // Apply rate limiting
  const limiters = getLimiters();
  if (limiters?.login) {
    return limiters.login(req, res, async () => {
      await handleLogin(req, res, next);
    });
  }
  await handleLogin(req, res, next);
});

async function handleLogin(req, res, next) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user
    const result = await query(
      `SELECT id, username, email, password_hash, display_name, avatar_url, bio,
              follower_count, following_count, video_count, role, created_at
       FROM users WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      logger.warn({ username }, 'Login attempt for non-existent user');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      logger.warn({ username, userId: user.id }, 'Login attempt with invalid password');
      auditLog('login_failed', user.id, { reason: 'invalid_password' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role || ROLES.USER;

    // Audit log
    auditLog('user_login', user.id, {
      username: user.username,
      ip: req.ip,
    });

    logger.info({ userId: user.id, username: user.username }, 'User logged in successfully');

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        bio: user.bio,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        videoCount: user.video_count,
        role: user.role || ROLES.USER,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Logout
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;

  req.session.destroy((err) => {
    if (err) {
      logger.error({ error: err.message }, 'Logout error');
      return res.status(500).json({ error: 'Could not log out' });
    }

    if (userId) {
      auditLog('user_logout', userId, {});
      logger.info({ userId }, 'User logged out');
    }

    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, email, display_name, avatar_url, bio,
              follower_count, following_count, video_count, like_count, role, created_at
       FROM users WHERE id = $1`,
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      bio: user.bio,
      followerCount: user.follower_count,
      followingCount: user.following_count,
      videoCount: user.video_count,
      likeCount: user.like_count,
      role: user.role || ROLES.USER,
      createdAt: user.created_at,
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.session.userId }, 'Get me error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upgrade to creator role (self-service)
router.post('/upgrade-to-creator', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    // Check current role
    const userResult = await query('SELECT role FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentRole = userResult.rows[0].role;
    if (currentRole !== ROLES.USER) {
      return res.status(400).json({ error: 'Already a creator or higher role' });
    }

    // Upgrade to creator
    await query('UPDATE users SET role = $1 WHERE id = $2', [ROLES.CREATOR, userId]);
    req.session.role = ROLES.CREATOR;

    auditLog('role_upgrade', userId, {
      fromRole: currentRole,
      toRole: ROLES.CREATOR,
    });

    logger.info({ userId }, 'User upgraded to creator role');

    res.json({
      message: 'Upgraded to creator successfully',
      role: ROLES.CREATOR,
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.session.userId }, 'Upgrade to creator error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
