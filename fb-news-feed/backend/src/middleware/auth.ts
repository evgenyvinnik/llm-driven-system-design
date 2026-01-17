/**
 * @fileoverview Authentication middleware for protecting API routes.
 * Implements session-based authentication with Redis caching for performance.
 * Sessions are validated against both Redis cache and PostgreSQL database.
 * Includes structured logging for authentication events.
 */

import { Request, Response, NextFunction } from 'express';
import { pool, redis } from '../db/connection.js';
import { componentLoggers, cacheOperationsTotal } from '../shared/index.js';
import type { User } from '../types/index.js';

const log = componentLoggers.auth;

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionToken?: string;
    }
  }
}

/**
 * Express middleware that validates Bearer tokens and attaches user to request.
 * First checks Redis cache for fast session lookup, falls back to PostgreSQL.
 * Caches valid sessions in Redis for 1 hour to reduce database load.
 *
 * @param req - Express request object (will have user and sessionToken attached on success)
 * @param res - Express response object
 * @param next - Express next function
 * @returns Promise that resolves when authentication check completes
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7);

    // Check Redis cache first
    const cachedUserId = await redis.get(`session:${token}`);

    if (cachedUserId) {
      cacheOperationsTotal.labels('session', 'hit').inc();

      // Get user from database
      const userResult = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [cachedUserId]
      );

      if (userResult.rows.length === 0) {
        log.warn({ cachedUserId }, 'User not found for cached session');
        res.status(401).json({ error: 'User not found' });
        return;
      }

      req.user = userResult.rows[0] as User;
      req.sessionToken = token;
      next();
      return;
    }

    cacheOperationsTotal.labels('session', 'miss').inc();

    // Check database for session
    const sessionResult = await pool.query(
      `SELECT s.*, u.*
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (sessionResult.rows.length === 0) {
      log.debug('Invalid or expired token');
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const session = sessionResult.rows[0];

    // Cache in Redis for 1 hour
    await redis.setex(`session:${token}`, 3600, session.user_id);

    req.user = {
      id: session.user_id,
      username: session.username,
      email: session.email,
      password_hash: session.password_hash,
      display_name: session.display_name,
      bio: session.bio,
      avatar_url: session.avatar_url,
      role: session.role,
      follower_count: session.follower_count,
      following_count: session.following_count,
      is_celebrity: session.is_celebrity,
      created_at: session.created_at,
      updated_at: session.updated_at,
    } as User;
    req.sessionToken = token;

    next();
  } catch (error) {
    log.error({ error }, 'Auth middleware error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Optional authentication middleware for routes that work with or without auth.
 * Attempts to authenticate if token is present, but continues without user if not.
 * Useful for routes like viewing posts where logged-in users see extra features.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * @returns Promise that resolves when authentication check completes
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  // If token is provided, try to authenticate
  await authMiddleware(req, res, () => {
    next();
  });
}

/**
 * Middleware that restricts access to admin users only.
 * Must be used after authMiddleware to ensure user is authenticated.
 * Returns 403 Forbidden if authenticated user is not an admin.
 *
 * @param req - Express request object (must have user from authMiddleware)
 * @param res - Express response object
 * @param next - Express next function
 */
export function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}
