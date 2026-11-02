import type { Request, Response, NextFunction } from 'express';
import { getSession, getUserById, User } from '../services/auth.js';

// Extend Express Request to include user property
declare global {
  namespace Express {
    interface Request {
      user?: User | null;
    }
  }
}

// Resolve the `session` cookie value to a user. Shared by the REST middleware
// and the WebSocket upgrade so both trust exactly the same session.
export async function resolveSessionUser(sessionId: string | undefined): Promise<User | null> {
  if (!sessionId) return null;
  const session = await getSession(sessionId);
  if (!session) return null;
  return getUserById(session.userId);
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    req.user = await resolveSessionUser(req.cookies?.session);
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    req.user = null;
    next();
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function requireRole(
  ...roles: string[]
): (req: Request, res: Response, next: NextFunction) => void {
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
