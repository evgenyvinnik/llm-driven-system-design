import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import pool from '../models/db.js';
import { setSession, deleteSession, SESSION_TTL } from '../models/redis.js';
import { authMiddleware } from '../middleware/auth.js';
import type { User } from '../types/index.js';

const router = Router();
const SALT_ROUNDS = 10;

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    // Check if email already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const result = await pool.query<User>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, avatar_url, role, created_at`,
      [email, passwordHash, name]
    );

    const user = result.rows[0];

    // Create default workspace for new user
    const workspaceResult = await pool.query(
      `INSERT INTO workspaces (name, icon, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`${name}'s Workspace`, '📝', user.id]
    );

    const workspaceId = workspaceResult.rows[0].id;

    // Add user to workspace
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [workspaceId, user.id, 'admin']
    );

    // Create a welcome page
    await pool.query(
      `INSERT INTO pages (workspace_id, title, icon, created_by)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, 'Welcome', '👋', user.id]
    );

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
 * Login with email and password
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
 * Logout current user
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
 * Get current user info
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
