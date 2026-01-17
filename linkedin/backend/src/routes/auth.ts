/**
 * Authentication routes for the LinkedIn clone.
 * Handles user registration, login/logout, and session management.
 * Uses session-based authentication stored in Redis.
 *
 * @module routes/auth
 */
import { Router, Request, Response } from 'express';
import * as userService from '../services/userService.js';
import { requireAuth } from '../middleware/auth.js';
import { publicRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { loginAttemptsTotal } from '../utils/metrics.js';
import {
  logLoginSuccess,
  logLoginFailure,
  createAuditLog,
  AuditEventType,
} from '../utils/audit.js';

const router = Router();

// Register
router.post('/register', publicRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, password, firstName, lastName, headline } = req.body;

    if (!email || !password || !firstName || !lastName) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const user = await userService.createUser(email, password, firstName, lastName, headline);
    req.session.userId = user.id;
    req.session.role = user.role;

    // Audit log
    await createAuditLog({
      eventType: AuditEventType.PROFILE_CREATED,
      actorId: user.id,
      actorIp: req.ip || undefined,
      targetType: 'user',
      targetId: user.id,
      action: 'register',
      details: { email },
    });

    // Log successful registration as login
    await logLoginSuccess(
      user.id,
      email,
      req.ip || 'unknown',
      req.get('User-Agent') || 'unknown'
    );

    logger.info({ userId: user.id, email }, 'User registered successfully');

    res.status(201).json({ user });
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('duplicate')) {
      res.status(409).json({ error: 'Email already exists' });
      return;
    }
    logger.error({ error }, 'Registration error');
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', publicRateLimit, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }

    const user = await userService.authenticateUser(email, password);
    if (!user) {
      // Track failed login
      loginAttemptsTotal.inc({ success: 'false' });

      // Audit log failed login
      await logLoginFailure(
        email,
        req.ip || 'unknown',
        req.get('User-Agent') || 'unknown',
        'Invalid credentials'
      );

      logger.warn({ email, ip: req.ip }, 'Login failed - invalid credentials');

      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    req.session.userId = user.id;
    req.session.role = user.role;

    // Track successful login
    loginAttemptsTotal.inc({ success: 'true' });

    // Audit log successful login
    await logLoginSuccess(
      user.id,
      email,
      req.ip || 'unknown',
      req.get('User-Agent') || 'unknown'
    );

    logger.info({ userId: user.id, email }, 'User logged in successfully');

    res.json({ user });
  } catch (error) {
    logger.error({ error }, 'Login error');
    res.status(500).json({ error: 'Login failed' });
  }
});

// Logout
router.post('/logout', (req: Request, res: Response) => {
  const userId = req.session.userId;

  req.session.destroy((err) => {
    if (err) {
      logger.error({ error: err }, 'Logout error');
      res.status(500).json({ error: 'Logout failed' });
      return;
    }

    // Audit log logout
    if (userId) {
      createAuditLog({
        eventType: AuditEventType.LOGOUT,
        actorId: userId,
        actorIp: req.ip || undefined,
        targetType: 'session',
        targetId: userId,
        action: 'logout',
      }).catch((error) => {
        logger.error({ error }, 'Failed to log logout event');
      });
    }

    res.clearCookie('connect.sid');

    logger.info({ userId }, 'User logged out');

    res.json({ message: 'Logged out' });
  });
});

// Get current user
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await userService.getUserById(req.session.userId!);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ user });
  } catch (error) {
    logger.error({ error, userId: req.session.userId }, 'Get user error');
    res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
