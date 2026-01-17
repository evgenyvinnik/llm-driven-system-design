import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db.js';
import redis from '../utils/redis.js';
import { authenticate } from '../middleware/auth.js';
import logger from '../shared/logger.js';
import type { UserPublic } from '../types/index.js';

/**
 * Authentication router handling user registration, login, logout, and session management.
 * Uses bcrypt for password hashing and Redis for session caching.
 * Sessions are stored in both PostgreSQL (persistent) and Redis (fast access).
 */
const router = Router();

/**
 * POST /api/auth/register
 * Creates a new user account with email, name, and password.
 * Generates a random avatar color and creates an initial session.
 * Returns user data and session token in both cookie and response body.
 *
 * @param req.body.email - User's email address (must be unique)
 * @param req.body.name - User's display name
 * @param req.body.password - Plain text password (hashed before storage)
 * @returns {ApiResponse<{user: UserPublic, token: string}>} Created user and session token
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, name, password } = req.body;

    if (!email || !name || !password) {
      res.status(400).json({ success: false, error: 'Email, name, and password are required' });
      return;
    }

    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      logger.debug({ email }, 'Registration failed: email already exists');
      res.status(409).json({ success: false, error: 'Email already registered' });
      return;
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Generate random avatar color
    const colors = ['#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6', '#3B82F6', '#8B5CF6', '#EC4899'];
    const avatar_color = colors[Math.floor(Math.random() * colors.length)];

    // Create user
    const result = await pool.query(
      `INSERT INTO users (email, name, password_hash, avatar_color)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, avatar_color, role`,
      [email, name, password_hash, avatar_color]
    );

    const user = result.rows[0] as UserPublic;

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO sessions (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    // Cache session in Redis
    await redis.setex(`session:${token}`, 7 * 24 * 3600, JSON.stringify(user));

    logger.info({ userId: user.id, email: user.email }, 'User registered');

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({
      success: true,
      data: { user, token },
    });
  } catch (error) {
    logger.error({ error }, 'Register error');
    res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Authenticates user with email and password credentials.
 * Creates a new 7-day session on successful authentication.
 * Returns user data and session token in both cookie and response body.
 *
 * @param req.body.email - User's email address
 * @param req.body.password - Plain text password to verify
 * @returns {ApiResponse<{user: UserPublic, token: string}>} Authenticated user and session token
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email and password are required' });
      return;
    }

    // Find user
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      logger.debug({ email }, 'Login failed: user not found');
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }

    const user = result.rows[0];

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      logger.debug({ email }, 'Login failed: invalid password');
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }

    // Create session
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO sessions (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, token, expiresAt]
    );

    const userPublic: UserPublic = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_color: user.avatar_color,
      role: user.role,
    };

    // Cache session in Redis
    await redis.setex(`session:${token}`, 7 * 24 * 3600, JSON.stringify(userPublic));

    logger.info({ userId: user.id, email: user.email }, 'User logged in');

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      success: true,
      data: { user: userPublic, token },
    });
  } catch (error) {
    logger.error({ error }, 'Login error');
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 * Terminates the current user session.
 * Removes session from both Redis cache and PostgreSQL database.
 * Clears the session cookie from the client.
 *
 * @returns {ApiResponse<void>} Success message
 */
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  try {
    const token = req.sessionToken;
    const userId = req.user?.id;

    if (token) {
      // Delete from Redis
      await redis.del(`session:${token}`);

      // Delete from database
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    }

    logger.info({ userId }, 'User logged out');

    res.clearCookie('session_token');
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Logout error');
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated user's information.
 * Used by frontend to verify session validity and get user data on page load.
 *
 * @returns {ApiResponse<{user: UserPublic}>} Current user's public information
 */
router.get('/me', authenticate, async (req: Request, res: Response) => {
  res.json({
    success: true,
    data: { user: req.user },
  });
});

/** Exports the authentication router for mounting in the main application */
export default router;
