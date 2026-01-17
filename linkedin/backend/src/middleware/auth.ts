import { Request, Response, NextFunction } from 'express';

/**
 * Express middleware that requires a valid authenticated session.
 * Checks for userId in the session and returns 401 if not present.
 * Used to protect routes that require any authenticated user.
 *
 * @param req - Express request object with session
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
 * Express middleware that requires admin role in addition to authentication.
 * Returns 401 for unauthenticated requests and 403 for non-admin users.
 * Used to protect admin-only routes like job creation and applicant management.
 *
 * @param req - Express request object with session
 * @param res - Express response object
 * @param next - Next middleware function
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
