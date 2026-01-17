import { Request, Response, NextFunction } from 'express';
import redis from '../utils/redis.js';
import pool from '../utils/db.js';
import logger from '../shared/logger.js';
import { recordCacheAccess } from '../shared/metrics.js';
import type { User, UserPublic } from '../types/index.js';

/**
 * Extends Express Request interface to include authenticated user information.
 * Allows type-safe access to user data in route handlers after authentication.
 */
declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
      sessionToken?: string;
    }
  }
}

/**
 * Authentication middleware that validates session tokens.
 * Checks tokens from cookies (session_token) or Authorization header (Bearer token).
 * First checks Redis cache, falls back to database for cache misses.
 * On successful validation, attaches user info to request object.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function to continue middleware chain
 * @returns Responds with 401 if no token or invalid session, otherwise calls next()
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from cookie or Authorization header
    const token =
      req.cookies?.session_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      logger.debug({ path: req.path }, 'Auth failed: no token provided');
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    // Check Redis for session
    const sessionData = await redis.get(`session:${token}`);

    if (!sessionData) {
      recordCacheAccess('session', false);

      // Check database as fallback
      const sessionResult = await pool.query(
        `SELECT s.*, u.id as user_id, u.email, u.name, u.avatar_color, u.role
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );

      if (sessionResult.rows.length === 0) {
        logger.debug({ path: req.path }, 'Auth failed: invalid or expired session');
        res.status(401).json({ success: false, error: 'Invalid or expired session' });
        return;
      }

      const session = sessionResult.rows[0];

      // Cache in Redis
      const userPublic: UserPublic = {
        id: session.user_id,
        email: session.email,
        name: session.name,
        avatar_color: session.avatar_color,
        role: session.role,
      };

      await redis.setex(
        `session:${token}`,
        3600, // 1 hour TTL
        JSON.stringify(userPublic)
      );

      logger.debug({ userId: userPublic.id, path: req.path }, 'Session validated from database');

      req.user = userPublic;
      req.sessionToken = token;
      next();
      return;
    }

    recordCacheAccess('session', true);
    req.user = JSON.parse(sessionData) as UserPublic;
    req.sessionToken = token;
    next();
  } catch (error) {
    logger.error({ error, path: req.path }, 'Auth middleware error');
    res.status(500).json({ success: false, error: 'Authentication error' });
  }
}

/**
 * Optional authentication middleware that does not require a valid session.
 * Attaches user info to request if token is valid, otherwise continues without error.
 * Useful for routes that have different behavior for authenticated vs anonymous users.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function to continue middleware chain
 * @returns Always calls next(), never returns an error response
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token =
      req.cookies?.session_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      next();
      return;
    }

    const sessionData = await redis.get(`session:${token}`);

    if (sessionData) {
      recordCacheAccess('session', true);
      req.user = JSON.parse(sessionData) as UserPublic;
      req.sessionToken = token;
    } else {
      recordCacheAccess('session', false);
    }

    next();
  } catch (error) {
    // Don't fail on error, just proceed without user
    logger.debug({ error }, 'Optional auth check failed, continuing without user');
    next();
  }
}

/**
 * Admin authorization middleware that restricts access to admin users only.
 * Must be used after authenticate middleware to ensure req.user is populated.
 *
 * @param req - Express request object with authenticated user
 * @param res - Express response object
 * @param next - Express next function to continue middleware chain
 * @returns Responds with 401/403 if not authenticated or not admin, otherwise calls next()
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'admin') {
    logger.warn({ userId: req.user.id, path: req.path }, 'Admin access denied');
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }

  next();
}
