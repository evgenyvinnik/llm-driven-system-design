import { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/authService.js';
import { User } from '../types/index.js';

/**
 * Extends Express Request interface to include authenticated user.
 * When auth middleware runs successfully, req.user will be populated.
 */
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Authentication middleware that requires a valid session.
 * Extracts token from cookie or Authorization header, validates the session,
 * and attaches the user to the request object. Returns 401 if not authenticated.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from cookie or Authorization header
    let token = req.cookies?.token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const user = await validateSession(token);
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Optional authentication middleware that doesn't require a valid session.
 * Attempts to authenticate but allows request to proceed even if unauthenticated.
 * Useful for endpoints that behave differently for logged-in users.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token = req.cookies?.token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (token) {
      const user = await validateSession(token);
      if (user) {
        req.user = user;
      }
    }

    next();
  } catch (_error) {
    // Don't fail for optional auth
    next();
  }
}

/**
 * Admin authorization middleware that requires admin role.
 * Must be used after authMiddleware to ensure req.user is populated.
 * Returns 403 Forbidden if user is not an admin.
 * @param req - Express request object with user attached
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
