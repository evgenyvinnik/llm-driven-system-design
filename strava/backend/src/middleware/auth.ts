import { Request, Response, NextFunction } from 'express';

export interface AuthenticatedRequest extends Request {
  session: Request['session'] & {
    userId?: string;
    username?: string;
    role?: string;
  };
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void | Response {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void | Response {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function optionalAuth(
  _req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  // Just continue - user info will be in req.session if logged in
  next();
}
