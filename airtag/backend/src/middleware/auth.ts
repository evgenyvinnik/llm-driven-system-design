import { Request, Response, NextFunction } from 'express';

/**
 * Middleware that requires a valid user session.
 * Returns 401 Unauthorized if no session exists.
 * Used to protect routes that require any authenticated user.
 *
 * @param req - Express request object with session data
 * @param res - Express response object
 * @param next - Express next function to continue middleware chain
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Middleware that requires admin role in addition to authentication.
 * Returns 401 if not authenticated, 403 if authenticated but not admin.
 * Used to protect admin dashboard routes and system-wide operations.
 *
 * @param req - Express request object with session data
 * @param res - Express response object
 * @param next - Express next function to continue middleware chain
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.session.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
