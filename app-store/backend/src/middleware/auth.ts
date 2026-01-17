import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService.js';
import type { User } from '../types/index.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionId;

  if (!sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await authService.validateSession(sessionId);

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.user = user;
  req.sessionId = sessionId;
  next();
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionId;

  if (sessionId) {
    const user = await authService.validateSession(sessionId);
    if (user) {
      req.user = user;
      req.sessionId = sessionId;
    }
  }

  next();
}

export function requireRole(...roles: User['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

export function requireDeveloper(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'developer' && req.user.role !== 'admin') {
    res.status(403).json({ error: 'Developer account required' });
    return;
  }

  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
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
