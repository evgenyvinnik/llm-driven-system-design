import { Request, Response, NextFunction } from 'express';

/**
 * Express middleware that requires an authenticated session.
 * Blocks unauthenticated requests with a 401 status code.
 * Used on all protected API routes to ensure only logged-in users can access them.
 * @param req - Express request object with session data
 * @param res - Express response object
 * @param next - Next middleware function
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Express middleware that requires admin privileges.
 * First checks for authentication, then allows the route handler to verify admin status.
 * Actual admin check is performed in the route handler using user data from the database.
 * @param req - Express request object with session data
 * @param res - Express response object
 * @param next - Next middleware function
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  // Admin check will be done in the route handler
  next();
}
