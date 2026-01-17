import { Request, Response, NextFunction } from 'express';
import { pool } from '../database.js';
import type { User } from '../types/index.js';

/**
 * Extended Express Request with authenticated user information.
 * Populated by authMiddleware after successful token validation.
 */
export interface AuthenticatedRequest extends Request {
  user?: User;
}

/**
 * Express middleware that validates Bearer token authentication.
 * Verifies the token against active sessions in the database and
 * attaches the authenticated user to the request object.
 * Returns 401 if token is missing, invalid, or expired.
 * @param req - Express request with authorization header
 * @param res - Express response for sending error responses
 * @param next - Express next function to continue middleware chain
 */
export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const result = await pool.query(
      `SELECT u.* FROM users u
       INNER JOIN sessions s ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.user = result.rows[0] as User;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Express middleware that restricts access to admin users only.
 * Must be used after authMiddleware to ensure user is authenticated.
 * Returns 403 if the authenticated user does not have admin role.
 * @param req - Authenticated request with user object
 * @param res - Express response for sending error responses
 * @param next - Express next function to continue middleware chain
 */
export function adminMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
