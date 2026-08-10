import { sessions } from '../utils/redis.js';
import { pool } from '../utils/db.js';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// User interface
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'user' | 'business_owner' | 'admin';
  review_count: number;
  created_at?: string;
}

// Extended request with user
export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

/** Validates session token and attaches user to request, returning 401 if unauthenticated. */
export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  try {
    const token =
      req.cookies?.session_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res
        .status(401)
        .json({ error: { message: 'Authentication required' } });
    }

    const session = await sessions.get(token);
    if (!session) {
      return res
        .status(401)
        .json({ error: { message: 'Invalid or expired session' } });
    }

    // Get user from database
    const result = await pool.query<AuthUser>(
      // created_at is included because the profile page renders "Member Since" from
      // req.user; without it the field read "Unknown" for every account.
      'SELECT id, email, name, avatar_url, role, review_count, created_at FROM users WHERE id = $1',
      [session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: { message: 'User not found' } });
    }

    req.user = result.rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: { message: 'Authentication failed' } });
  }
}

/** Attaches user to request if authenticated, but does not reject unauthenticated requests. */
export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token =
      req.cookies?.session_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const session = await sessions.get(token);
      if (session) {
        const result = await pool.query<AuthUser>(
          // created_at is included because the profile page renders "Member Since"
          // from req.user; without it the field read "Unknown" for every account.
          'SELECT id, email, name, avatar_url, role, review_count, created_at FROM users WHERE id = $1',
          [session.userId]
        );
        if (result.rows.length > 0) {
          req.user = result.rows[0];
          req.sessionToken = token;
        }
      }
    }
    next();
  } catch (error) {
    console.error('Optional auth error:', error);
    next();
  }
}

/** Returns middleware that restricts access to users with the specified roles. */
export function requireRole(
  ...roles: Array<'user' | 'business_owner' | 'admin'>
): RequestHandler {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void | Response => {
    if (!req.user) {
      return res
        .status(401)
        .json({ error: { message: 'Authentication required' } });
    }

    if (!roles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ error: { message: 'Insufficient permissions' } });
    }

    next();
  };
}

/** Middleware restricting access to admin users only. */
export const requireAdmin: RequestHandler = requireRole('admin');

/** Middleware restricting access to business owners and admins. */
export const requireBusinessOwner: RequestHandler = requireRole(
  'business_owner',
  'admin'
);
