import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { register, login, logout, updateUser } from '../services/authService.js';
import { authMiddleware } from '../middleware/auth.js';

/**
 * Authentication routes for user registration, login, and session management.
 * Provides endpoints for the user authentication flow and profile management.
 * @module routes/auth
 */
const router = Router();

/** Zod schema for validating registration requests */
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

/** Zod schema for validating login requests */
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * POST /register - Creates a new user account.
 * Validates email format and password length, hashes password, creates session.
 * Sets httpOnly cookie with session token.
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = registerSchema.parse(req.body);
    const { user, token } = await register(email, password);

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.status(201).json({ user, token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
      return;
    }
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /login - Authenticates user with email and password.
 * Returns user data and sets session cookie on success.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const { user, token } = await login(email, password);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ user, token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors[0].message });
      return;
    }
    if (error instanceof Error) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /logout - Invalidates the current session.
 * Clears session from Redis/database and removes cookie.
 * Requires authentication.
 */
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.token || req.headers.authorization?.substring(7);
    if (token) {
      await logout(token);
    }

    res.clearCookie('token');
    res.json({ message: 'Logged out successfully' });
  } catch (_error) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

/**
 * GET /me - Returns the currently authenticated user.
 * Used by frontend to verify authentication state on page load.
 */
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

/**
 * PATCH /me - Updates current user's settings.
 * Currently supports updating email notification preferences.
 */
router.patch('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { email_notifications } = req.body;
    const user = await updateUser(req.user!.id, { email_notifications });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user });
  } catch (_error) {
    res.status(500).json({ error: 'Update failed' });
  }
});

export default router;
