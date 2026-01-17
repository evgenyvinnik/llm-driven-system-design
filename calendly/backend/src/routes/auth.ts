import { Router, Request, Response } from 'express';
import { userService } from '../services/userService.js';
import { CreateUserSchema } from '../types/index.js';
import { z } from 'zod';

/**
 * Express router for authentication endpoints.
 * Handles user registration, login, logout, and session management.
 */
const router = Router();

/**
 * POST /api/auth/register - Register a new user.
 * Creates a new account and automatically logs in the user.
 * @body {email, password, name, time_zone} - User registration data
 * @returns {User} The newly created user
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const input = CreateUserSchema.parse(req.body);
    const user = await userService.createUser(input);

    // Auto-login after registration
    req.session.userId = user.id;
    req.session.user = user;

    res.status(201).json({
      success: true,
      data: user,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Registration failed',
    });
  }
});

/**
 * POST /api/auth/login - Authenticate a user.
 * Validates credentials and establishes a session.
 * @body {email, password} - User credentials
 * @returns {User} The authenticated user
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
      return;
    }

    const user = await userService.validateCredentials(email, password);

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    req.session.userId = user.id;
    req.session.user = user;

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Login failed',
    });
  }
});

/**
 * POST /api/auth/logout - End the current session.
 * Destroys the session and clears the session cookie.
 * @returns {message} Success message
 */
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({
        success: false,
        error: 'Logout failed',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  });
});

/**
 * GET /api/auth/me - Get the current authenticated user.
 * Used by frontend to check authentication status and get user data.
 * @returns {User} The current user or 401 if not authenticated
 */
router.get('/me', async (req: Request, res: Response) => {
  if (!req.session?.userId) {
    res.status(401).json({
      success: false,
      error: 'Not authenticated',
    });
    return;
  }

  try {
    const user = await userService.findById(req.session.userId);

    if (!user) {
      req.session.destroy(() => {});
      res.status(401).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get user',
    });
  }
});

export default router;
