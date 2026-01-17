import { Request, Response, NextFunction } from 'express';
import redis from '../utils/redis.js';
import pool from '../utils/db.js';
import type { User, UserPublic } from '../types/index.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
      sessionToken?: string;
    }
  }
}

/**
 * Authentication middleware
 * Validates session token from cookie or Authorization header
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
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    // Check Redis for session
    const sessionData = await redis.get(`session:${token}`);

    if (!sessionData) {
      // Check database as fallback
      const sessionResult = await pool.query(
        `SELECT s.*, u.id as user_id, u.email, u.name, u.avatar_color, u.role
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );

      if (sessionResult.rows.length === 0) {
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

      req.user = userPublic;
      req.sessionToken = token;
      next();
      return;
    }

    req.user = JSON.parse(sessionData) as UserPublic;
    req.sessionToken = token;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ success: false, error: 'Authentication error' });
  }
}

/**
 * Optional authentication - doesn't fail if no token
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
      req.user = JSON.parse(sessionData) as UserPublic;
      req.sessionToken = token;
    }

    next();
  } catch (error) {
    // Don't fail on error, just proceed without user
    next();
  }
}

/**
 * Admin-only middleware
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
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }

  next();
}
