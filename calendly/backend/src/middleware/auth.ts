import { Request, Response, NextFunction } from 'express';
import { type User } from '../types/index.js';

/**
 * Express session data extension to include user authentication info.
 * Allows TypeScript to recognize userId and user on req.session.
 */
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    user?: User;
  }
}

/**
 * Middleware that requires a valid authenticated session.
 * Returns 401 Unauthorized if no session exists.
 * Use on routes that require user login.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
    return;
  }
  next();
}

/**
 * Middleware that requires admin role in addition to authentication.
 * Returns 401 if not authenticated, 403 if authenticated but not admin.
 * Use on admin-only routes like user management and system stats.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
    return;
  }

  if (req.session.user?.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Admin access required',
    });
    return;
  }

  next();
}

/**
 * Middleware that attaches user info if available but does not require it.
 * Use on public routes that may show different content for logged-in users.
 * Session data will be available if user is authenticated.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  // Just pass through - session info will be available if user is logged in
  next();
}
