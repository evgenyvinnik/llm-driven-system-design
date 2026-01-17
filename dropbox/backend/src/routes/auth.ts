/**
 * Authentication routes for user registration, login, and session management.
 * Endpoints: POST /register, POST /login, POST /logout, GET /me, PATCH /me
 * @module routes/auth
 */

import { Router, Request, Response } from 'express';
import { register, login, logout, updateUser, getUserById } from '../services/authService.js';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/register - Create a new user account.
 * Body: { email: string, password: string, name: string }
 * Returns: User profile and session token (also sets httpOnly cookie)
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const result = await register(email, password, name);

    // Set cookie
    res.cookie('token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.status(201).json(result);
  } catch (error) {
    console.error('Register error:', error);
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/auth/login - Authenticate and create a session.
 * Body: { email: string, password: string }
 * Returns: User profile and session token (also sets httpOnly cookie)
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const result = await login(email, password);

    // Set cookie
    res.cookie('token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.json(result);
  } catch (error) {
    console.error('Login error:', error);
    res.status(401).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/auth/logout - Terminate the current session.
 * Requires authentication. Clears session and removes cookie.
 */
router.post('/logout', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.token) {
      await logout(req.token);
    }

    res.clearCookie('token');
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

/**
 * GET /api/auth/me - Get the current user's profile.
 * Requires authentication. Returns up-to-date user profile data.
 */
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const user = await getUserById(req.user.id);
    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

/**
 * PATCH /api/auth/me - Update the current user's profile.
 * Requires authentication.
 * Body: { name?: string, password?: string }
 */
router.patch('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { name, password } = req.body;

    if (password && password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }

    const user = await updateUser(req.user.id, { name, password });
    res.json({ user });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

export default router;
