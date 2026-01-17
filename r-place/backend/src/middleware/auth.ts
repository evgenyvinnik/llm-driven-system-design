import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.js';
import type { User } from '../types/index.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

// Authentication middleware
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
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

// Optional auth - doesn't fail if not authenticated
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const sessionId = req.cookies?.session;

  if (sessionId) {
    const user = await authService.validateSession(sessionId);
    if (user) {
      req.user = user;
      req.sessionId = sessionId;
    }
  }

  next();
}

// Admin-only middleware
export async function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
