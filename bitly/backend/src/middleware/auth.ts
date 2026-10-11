import { Request, Response, NextFunction } from 'express';
import { getUserByToken } from '../services/authService.js';
import { AUTH_CONFIG } from '../config.js';
import { UserPublic } from '../models/types.js';
import logger from '../utils/logger.js';

/**
 * Extends the Express Request interface to include an optional user property.
 * Populated by authentication middleware for use in route handlers.
 */
declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
    }
  }
}

/**
 * Extracts the session token from the session cookie or a Bearer Authorization header.
 * @param req - Express request object
 * @returns The token, or undefined when none was presented
 */
export function getRequestToken(req: Request): string | undefined {
  return req.cookies?.[AUTH_CONFIG.cookieName] || req.headers.authorization?.replace('Bearer ', '') || undefined;
}

/**
 * Optional authentication middleware.
 * Attaches user to request if valid session exists, but allows unauthenticated access.
 * Used for routes that work for both anonymous and authenticated users.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getRequestToken(req);
  if (!token) {
    next();
    return;
  }

  try {
    const user = await getUserByToken(token);
    if (user) {
      req.user = user;
    }
  } catch (error) {
    // A credential was presented but could not be checked. Continuing anonymously would
    // e.g. create an unowned link for a logged-in user, so fail the request instead.
    logger.error({ err: error }, 'Optional authentication failed');
    res.status(503).json({ error: 'Authentication service unavailable, please retry' });
    return;
  }

  next();
}

/**
 * Required authentication middleware.
 * Returns 401 Unauthorized if no valid session exists.
 * Attaches user to request for authorized requests.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getRequestToken(req);

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const user = await getUserByToken(token);

    if (!user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error({ err: error }, 'Authentication failed');
    res.status(503).json({ error: 'Authentication service unavailable, please retry' });
  }
}

/**
 * Admin-only authentication middleware.
 * Returns 401 if not authenticated, 403 if authenticated but not admin.
 * Used for admin dashboard and management endpoints.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getRequestToken(req);

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const user = await getUserByToken(token);

    if (!user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error({ err: error }, 'Authentication failed');
    res.status(503).json({ error: 'Authentication service unavailable, please retry' });
  }
}
