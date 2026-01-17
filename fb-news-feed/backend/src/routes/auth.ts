/**
 * @fileoverview Authentication routes for user registration, login, and logout.
 * Handles session creation with UUID tokens stored in both PostgreSQL and Redis.
 * Sessions expire after 7 days and are cached in Redis for fast validation.
 * Includes authentication metrics for monitoring login patterns.
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { pool, redis } from '../db/connection.js';
import { authMiddleware } from '../middleware/auth.js';
import { componentLoggers, authAttemptsTotal } from '../shared/index.js';
import type { RegisterRequest, LoginRequest, UserPublic } from '../types/index.js';

const log = componentLoggers.auth;

/** Express router for authentication endpoints */
const router = Router();

/**
 * POST /register - Creates a new user account with hashed password.
 * Validates uniqueness of email and username before creating user.
 * Automatically creates session and returns token for immediate login.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password, display_name } = req.body as RegisterRequest;

    if (!username || !email || !password || !display_name) {
      res.status(400).json({ error: 'All fields are required' });
      return;
    }

    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existingUser.rows.length > 0) {
      res.status(409).json({ error: 'User already exists' });
      return;
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, display_name, bio, avatar_url, follower_count, following_count, is_celebrity, created_at`,
      [username, email, password_hash, display_name]
    );

    const user = result.rows[0];

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    // Cache session in Redis
    await redis.setex(`session:${token}`, 7 * 24 * 60 * 60, user.id);

    // Record metrics
    authAttemptsTotal.labels('register', 'success').inc();

    log.info({ userId: user.id, username: user.username }, 'User registered');

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio,
        avatar_url: user.avatar_url,
        follower_count: user.follower_count,
        following_count: user.following_count,
        is_celebrity: user.is_celebrity,
        created_at: user.created_at,
      } as UserPublic,
      token,
    });
  } catch (error) {
    authAttemptsTotal.labels('register', 'failure').inc();
    log.error({ error }, 'Register error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /login - Authenticates user with email and password.
 * Verifies password against bcrypt hash and creates new session.
 * Returns user profile and session token on success.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as LoginRequest;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // Find user
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    // Cache session in Redis
    await redis.setex(`session:${token}`, 7 * 24 * 60 * 60, user.id);

    // Record metrics
    authAttemptsTotal.labels('login', 'success').inc();

    log.info({ userId: user.id, email: user.email }, 'User logged in');

    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio,
        avatar_url: user.avatar_url,
        follower_count: user.follower_count,
        following_count: user.following_count,
        is_celebrity: user.is_celebrity,
        created_at: user.created_at,
      } as UserPublic,
      token,
    });
  } catch (error) {
    authAttemptsTotal.labels('login', 'failure').inc();
    log.error({ error }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /logout - Invalidates the current session.
 * Removes session from both PostgreSQL and Redis cache.
 * Requires valid authentication token.
 */
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    const token = req.sessionToken;

    // Delete from database
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);

    // Delete from Redis
    await redis.del(`session:${token}`);

    // Record metrics
    authAttemptsTotal.labels('logout', 'success').inc();

    log.info({ userId: req.user?.id }, 'User logged out');

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    authAttemptsTotal.labels('logout', 'failure').inc();
    log.error({ error }, 'Logout error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /me - Returns the authenticated user's profile.
 * Used by frontend to validate session and get current user data.
 * Requires valid authentication token.
 */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = req.user!;

    res.json({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      bio: user.bio,
      avatar_url: user.avatar_url,
      follower_count: user.follower_count,
      following_count: user.following_count,
      is_celebrity: user.is_celebrity,
      role: user.role,
      created_at: user.created_at,
    });
  } catch (error) {
    log.error({ error }, 'Get me error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
