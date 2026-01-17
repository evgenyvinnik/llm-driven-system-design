/**
 * @fileoverview Authentication API routes.
 *
 * Exposes REST endpoints for:
 * - User login (session creation)
 * - User logout (session destruction)
 * - Current user info retrieval
 * - User registration (admin only)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import pool from '../db/pool.js';
import logger from '../shared/logger.js';
import {
  requireAuth,
  requireRole,
  hashPassword,
  verifyPassword,
  type Role,
} from '../shared/auth.js';
import type { User } from '../types/index.js';

const router = Router();

/**
 * Zod schema for login request validation.
 */
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Zod schema for registration request validation.
 */
const RegisterSchema = z.object({
  username: z.string().min(3).max(50),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
});

/**
 * POST /login
 * Authenticates a user and creates a session.
 *
 * @body {email, password} - User credentials
 * @returns User info on success, error on failure
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const validation = LoginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors,
      });
    }

    const { email, password } = validation.data;

    // Find user by email
    const result = await pool.query<User>(
      'SELECT id, username, email, password_hash, role FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      // Use generic error message to prevent user enumeration
      logger.info({ email }, 'Login failed: User not found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      logger.info({ email, userId: user.id }, 'Login failed: Invalid password');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    req.session.userId = user.id;
    req.session.role = user.role as Role;

    logger.info({ userId: user.id, email }, 'User logged in');

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    });
  } catch (error) {
    logger.error({ error }, 'Login error');
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /logout
 * Destroys the current session.
 *
 * @returns 200 OK on success
 */
router.post('/logout', (req: Request, res: Response) => {
  const userId = req.session?.userId;

  req.session.destroy((err) => {
    if (err) {
      logger.error({ error: err, userId }, 'Logout error');
      return res.status(500).json({ error: 'Logout failed' });
    }

    res.clearCookie('dashboarding.sid');
    logger.info({ userId }, 'User logged out');
    res.json({ message: 'Logged out successfully' });
  });
});

/**
 * GET /me
 * Returns the current authenticated user's information.
 *
 * @returns User info or 401 if not authenticated
 */
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;

    const result = await pool.query<Omit<User, 'password_hash'>>(
      'SELECT id, username, email, role, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error({ error }, 'Get current user error');
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

/**
 * POST /register
 * Creates a new user account. Admin only.
 *
 * @body {username, email, password, role?}
 * @returns The newly created user
 */
router.post('/register', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const validation = RegisterSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: validation.error.errors,
      });
    }

    const { username, email, password, role = 'viewer' } = validation.data;

    // Check if email already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password and create user
    const passwordHash = await hashPassword(password);

    const result = await pool.query<Omit<User, 'password_hash'>>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, role, created_at, updated_at`,
      [username, email, passwordHash, role]
    );

    logger.info({
      newUserId: result.rows[0].id,
      email,
      role,
      createdBy: req.session.userId,
    }, 'User registered');

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error({ error }, 'Registration error');
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * GET /users
 * Lists all users. Admin only.
 *
 * @returns Array of users (without password hashes)
 */
router.get('/users', requireAuth, requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query<Omit<User, 'password_hash'>>(
      'SELECT id, username, email, role, created_at, updated_at FROM users ORDER BY created_at DESC'
    );

    res.json({ users: result.rows });
  } catch (error) {
    logger.error({ error }, 'List users error');
    res.status(500).json({ error: 'Failed to list users' });
  }
});

export default router;
