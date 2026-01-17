import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../services/db.js';
import { loginRateLimiter } from '../services/rateLimiter.js';
import logger from '../services/logger.js';
import { authAttempts, activeSessions } from '../services/metrics.js';

const router = Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, displayName } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if username or email already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      authAttempts.labels('register', 'failure').inc();
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const result = await query(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, bio, profile_picture_url,
                 follower_count, following_count, post_count, role, created_at`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash, displayName || username]
    );

    const user = result.rows[0];

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.isVerified = user.role === 'verified' || user.role === 'admin';

    // Track metrics
    authAttempts.labels('register', 'success').inc();
    activeSessions.inc();

    logger.info({
      type: 'user_registered',
      userId: user.id,
      username: user.username,
    }, `User registered: ${user.username}`);

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        bio: user.bio,
        profilePictureUrl: user.profile_picture_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        postCount: user.post_count,
        role: user.role,
      },
    });
  } catch (error) {
    authAttempts.labels('register', 'failure').inc();
    logger.error({
      type: 'registration_error',
      error: error.message,
    }, `Registration error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login - with rate limiting to prevent brute force
router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find user
    const result = await query(
      `SELECT id, username, email, password_hash, display_name, bio,
              profile_picture_url, follower_count, following_count, post_count, role
       FROM users WHERE username = $1 OR email = $1`,
      [username.toLowerCase()]
    );

    if (result.rows.length === 0) {
      authAttempts.labels('login', 'failure').inc();
      logger.warn({
        type: 'login_failed',
        reason: 'user_not_found',
        username: username.toLowerCase(),
        ip: req.ip,
      }, `Login failed: user not found - ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      authAttempts.labels('login', 'failure').inc();
      logger.warn({
        type: 'login_failed',
        reason: 'invalid_password',
        userId: user.id,
        username: user.username,
        ip: req.ip,
      }, `Login failed: invalid password - ${user.username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Set session with role information
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.isVerified = user.role === 'verified' || user.role === 'admin';

    // Track metrics
    authAttempts.labels('login', 'success').inc();
    activeSessions.inc();

    logger.info({
      type: 'login_success',
      userId: user.id,
      username: user.username,
      role: user.role,
      ip: req.ip,
    }, `User logged in: ${user.username}`);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        bio: user.bio,
        profilePictureUrl: user.profile_picture_url,
        followerCount: user.follower_count,
        followingCount: user.following_count,
        postCount: user.post_count,
        role: user.role,
      },
    });
  } catch (error) {
    authAttempts.labels('login', 'failure').inc();
    logger.error({
      type: 'login_error',
      error: error.message,
    }, `Login error: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  const userId = req.session?.userId;
  const username = req.session?.username;

  req.session.destroy((err) => {
    if (err) {
      logger.error({
        type: 'logout_error',
        error: err.message,
        userId,
      }, `Logout error: ${err.message}`);
      return res.status(500).json({ error: 'Could not log out' });
    }

    // Track metrics
    activeSessions.dec();

    logger.info({
      type: 'logout',
      userId,
      username,
    }, `User logged out: ${username}`);

    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  query(
    `SELECT id, username, email, display_name, bio, profile_picture_url,
            follower_count, following_count, post_count, role
     FROM users WHERE id = $1`,
    [req.session.userId]
  )
    .then((result) => {
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const user = result.rows[0];
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          bio: user.bio,
          profilePictureUrl: user.profile_picture_url,
          followerCount: user.follower_count,
          followingCount: user.following_count,
          postCount: user.post_count,
          role: user.role,
        },
      });
    })
    .catch((error) => {
      logger.error({
        type: 'get_me_error',
        error: error.message,
        userId: req.session.userId,
      }, `Get me error: ${error.message}`);
      res.status(500).json({ error: 'Internal server error' });
    });
});

export default router;
