/**
 * @fileoverview Authentication routes for user registration, login, and profile management.
 * Handles session-based authentication using express-session.
 * All passwords are hashed with bcrypt before storage.
 * Includes cache invalidation on profile updates.
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { invalidateUserCache } from '../services/cache.js';
import { logger } from '../services/logger.js';
import type { User } from '../types/index.js';

const router = Router();

/**
 * POST /auth/register - Create a new user account.
 * Validates input, checks for duplicate email, hashes password,
 * and creates the user session.
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, username, display_name } = req.body;

    if (!email || !password || !username) {
      res.status(400).json({ error: 'Email, password, and username are required' });
      return;
    }

    // Check if user exists
    const existingUser = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await query<User>(
      `INSERT INTO users (email, password_hash, username, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, display_name, avatar_url, created_at`,
      [email, passwordHash, username, display_name || username]
    );

    const user = result.rows[0];
    req.session.userId = user.id;

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * POST /auth/login - Authenticate user and create session.
 * Validates credentials and creates a session cookie.
 */
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // Find user
    const result = await query<User & { password_hash: string }>(
      'SELECT id, email, password_hash, username, display_name, avatar_url FROM users WHERE email = $1',
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

    req.session.userId = user.id;

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /auth/logout - End the user session.
 * Destroys the session and clears the session cookie.
 */
router.post('/logout', (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: 'Logout failed' });
      return;
    }
    res.json({ message: 'Logged out successfully' });
  });
});

/**
 * GET /auth/me - Get the currently authenticated user.
 * Returns user profile data without sensitive fields.
 */
router.get('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<User>(
      'SELECT id, email, username, display_name, avatar_url FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * PUT /auth/me - Update the authenticated user's profile.
 * Allows updating display_name and avatar_url.
 * Invalidates user cache after update.
 */
router.put('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { display_name, avatar_url } = req.body;

    const result = await query<User>(
      `UPDATE users SET display_name = COALESCE($1, display_name),
       avatar_url = COALESCE($2, avatar_url), updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, username, display_name, avatar_url`,
      [display_name, avatar_url, req.session.userId]
    );

    // Invalidate cache after profile update
    await invalidateUserCache(req.session.userId!);

    logger.info({ msg: 'Profile updated', userId: req.session.userId });

    res.json(result.rows[0]);
  } catch (error) {
    logger.error({ err: error, msg: 'Update profile error' });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
