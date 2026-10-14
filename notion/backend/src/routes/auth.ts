/**
 * @fileoverview Authentication routes for user registration, login, and session management.
 * Uses bcrypt for password hashing and Redis-backed sessions via HTTP-only cookies.
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import pool from '../models/db.js';
import { setSession, deleteSession, SESSION_TTL } from '../models/redis.js';
import { authMiddleware } from '../middleware/auth.js';
import type { User } from '../types/index.js';

const router = Router();

/** Number of bcrypt salt rounds for password hashing */
const SALT_ROUNDS = 10;

/**
 * POST /api/auth/register
 * Registers a new user and creates their default workspace.
 * Sets up a session and returns the user with an auth token.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // The user, their workspace, membership and welcome page commit together
    // (a failure halfway used to leave a user without a workspace). The unique
    // index on email, not a prior SELECT, decides concurrent registrations.
    const client = await pool.connect();
    let user: User;
    try {
      await client.query('BEGIN');
      const result = await client.query<User>(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3)
         RETURNING id, email, name, avatar_url, role, created_at`,
        [email, passwordHash, name]
      );
      user = result.rows[0];

      const workspaceResult = await client.query(
        `INSERT INTO workspaces (name, icon, owner_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [`${name}'s Workspace`, '📝', user.id]
      );
      const workspaceId = workspaceResult.rows[0].id;

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [workspaceId, user.id]
      );
      await client.query(
        `INSERT INTO pages (workspace_id, title, icon, position, created_by)
         VALUES ($1, $2, $3, 'n', $4)`,
        [workspaceId, 'Welcome', '👋', user.id]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }
      throw error;
    } finally {
      client.release();
    }

    // Create session token
    const token = uuidv4();
    await setSession(token, user.id);

    // Set cookie
    res.cookie('session_token', token, {
      httpOnly: true,
      maxAge: SESSION_TTL * 1000,
      sameSite: 'lax',
    });

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Authenticates a user with email and password.
 * Creates a new session and sets an HTTP-only cookie.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // Get user by email
    const result = await pool.query<User>(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = result.rows[0];

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Create session token
    const token = uuidv4();
    await setSession(token, user.id);

    // Set cookie
    res.cookie('session_token', token, {
      httpOnly: true,
      maxAge: SESSION_TTL * 1000,
      sameSite: 'lax',
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar_url: user.avatar_url,
      },
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/logout
 * Invalidates the current session and clears the session cookie.
 * Requires authentication.
 */
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (req.sessionToken) {
      await deleteSession(req.sessionToken);
    }

    res.clearCookie('session_token');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

/**
 * GET /api/auth/me
 * Returns the currently authenticated user's information.
 * Used by the frontend to verify authentication state.
 */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    res.json({
      user: {
        id: req.user!.id,
        email: req.user!.email,
        name: req.user!.name,
        role: req.user!.role,
        avatar_url: req.user!.avatar_url,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

export default router;
