import { Request, Response, NextFunction } from 'express';
import { getSession } from '../models/redis.js';
import pool from '../models/db.js';
import type { User } from '../types/index.js';

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
 * Authentication middleware
 * Checks for session token in cookie or Authorization header
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from cookie or header
    const token =
      req.cookies?.session_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Check session in Redis
    const userId = await getSession(token);
    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    // Get user from database
    const result = await pool.query<User>(
      'SELECT id, email, name, avatar_url, role, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = result.rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional authentication middleware
 * Sets user if authenticated, but doesn't block request if not
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token =
      req.cookies?.session_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const userId = await getSession(token);
      if (userId) {
        const result = await pool.query<User>(
          'SELECT id, email, name, avatar_url, role, created_at, updated_at FROM users WHERE id = $1',
          [userId]
        );

        if (result.rows.length > 0) {
          req.user = result.rows[0];
          req.sessionToken = token;
        }
      }
    }

    next();
  } catch (error) {
    // Don't block request on auth errors for optional auth
    console.error('Optional auth error:', error);
    next();
  }
}

/**
 * Admin-only middleware
 * Must be used after authMiddleware
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
