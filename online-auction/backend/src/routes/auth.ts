import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { setSession, deleteSession } from '../redis.js';
import { authenticate } from '../middleware/auth.js';
import type { AuthenticatedRequest, User } from '../types.js';

const router = express.Router();

// Register a new user
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    res.status(400).json({ error: 'Username, email, and password are required' });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  try {
    // Check if user already exists
    const existingUser = await query('SELECT id FROM users WHERE username = $1 OR email = $2', [
      username,
      email,
    ]);

    if (existingUser.rows.length > 0) {
      res.status(409).json({ error: 'Username or email already exists' });
      return;
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, role',
      [username, email, passwordHash]
    );

    const user = result.rows[0] as User;

    // Create session
    const token = uuidv4();
    await setSession(token, user.id);

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  try {
    const result = await query(
      'SELECT id, username, email, role, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const user = result.rows[0] as User & { password_hash: string };
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Create session
    const token = uuidv4();
    await setSession(token, user.id);

    res.cookie('session_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    const { password_hash: _, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Logout
router.post(
  '/logout',
  authenticate as express.RequestHandler,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (req.sessionToken) {
        await deleteSession(req.sessionToken);
      }
      res.clearCookie('session_token');
      res.json({ message: 'Logged out successfully' });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Failed to logout' });
    }
  }
);

// Get current user
router.get(
  '/me',
  authenticate as express.RequestHandler,
  (req: AuthenticatedRequest, res: Response): void => {
    res.json({ user: req.user });
  }
);

// Update profile
router.put(
  '/me',
  authenticate as express.RequestHandler,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { username, email } = req.body;

    try {
      const result = await query(
        'UPDATE users SET username = COALESCE($1, username), email = COALESCE($2, email) WHERE id = $3 RETURNING id, username, email, role',
        [username, email, req.user?.id]
      );

      res.json({ user: result.rows[0] });
    } catch (error) {
      console.error('Profile update error:', error);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }
);

export default router;
