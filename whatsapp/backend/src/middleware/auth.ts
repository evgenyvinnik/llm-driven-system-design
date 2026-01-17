import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  // Just continue - userId may or may not be set
  next();
}
