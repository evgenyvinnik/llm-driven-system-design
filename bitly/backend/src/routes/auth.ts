import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getRequestToken } from '../middleware/auth.js';
import { AUTH_CONFIG } from '../config.js';
import logger from '../utils/logger.js';
import {
  createUser,
  loginUser,
  logoutUser,
  getUserByToken,
} from '../services/authService.js';

/**
 * Authentication router.
 * Provides user registration, login, logout, and session management.
 * Routes: POST /register, POST /login, POST /logout, GET /me
 */
const router = Router();

/**
 * POST /register - Create a new user account
 * Requires email and password in request body.
 * Returns the created user (without password).
 */
router.post(
  '/register',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    try {
      const user = await createUser({ email, password });
      res.status(201).json(user);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed';
      res.status(400).json({ error: message });
    }
  })
);

/**
 * POST /login - Authenticate user and create session
 * Sets httpOnly cookie with session token.
 * Returns user data and token in response body.
 */
router.post(
  '/login',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const result = await loginUser(email, password);

    if (!result) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Set session cookie
    res.cookie(AUTH_CONFIG.cookieName, result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: AUTH_CONFIG.sessionDuration,
    });

    res.json({ user: result.user, token: result.token });
  })
);

/**
 * POST /logout - Invalidate current session
 * Clears the session cookie (always: the browser asked to log out) and revokes the
 * session in cache and database. If revocation cannot be confirmed the response is 503,
 * so the client knows the server-side session may still be valid.
 */
router.post(
  '/logout',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const token = getRequestToken(req);

    res.clearCookie(AUTH_CONFIG.cookieName);

    if (token) {
      try {
        await logoutUser(token);
      } catch (error) {
        logger.error({ err: error }, 'Logout could not revoke the session');
        res.status(503).json({ error: 'Logout could not be completed on the server, please retry' });
        return;
      }
    }

    res.json({ message: 'Logged out successfully' });
  })
);

/**
 * GET /me - Get current authenticated user
 * Returns user data if session is valid, 401 otherwise.
 */
router.get(
  '/me',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const token = getRequestToken(req);

    if (!token) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const user = await getUserByToken(token);

    if (!user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    res.json(user);
  })
);

export default router;
