import { Request, Response, NextFunction } from 'express';
import { getUserById } from '../services/userService.js';
import { User } from '../types/index.js';

/**
 * Extends Express Request type to include the authenticated user.
 * This declaration merges with Express's types globally.
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
 * Verifies the session contains a valid user ID, loads the user from the database,
 * and attaches it to the request object. Returns 401 if authentication fails.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await getUserById(userId);
  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: 'User not found' });
    return;
  }

  req.user = user;
  next();
}

/**
 * Optional authentication middleware that attaches user if logged in.
 * Unlike requireAuth, this middleware allows unauthenticated requests to proceed.
 * Useful for endpoints that behave differently for authenticated users.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;

  if (userId) {
    const user = await getUserById(userId);
    if (user) {
      req.user = user;
    }
  }

  next();
}

/**
 * Admin authorization middleware that requires admin role.
 * Must be used after requireAuth to ensure req.user exists.
 * Returns 403 if the user is not an admin.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
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
