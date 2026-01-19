import type { Response, NextFunction } from 'express';
import { getSession, findUserById } from '../models/user.js';
import type { AuthenticatedRequest } from '../shared/logger.js';

export const authenticate = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  const sessionId = req.cookies?.session || req.headers['x-session-id'];

  if (!sessionId || typeof sessionId !== 'string') {
    req.user = null;
    next();
    return;
  }

  try {
    const session = await getSession(sessionId);
    if (!session) {
      req.user = null;
      next();
      return;
    }

    const user = await findUserById(session.userId);
    req.user = user ?? null;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    req.user = null;
    next();
  }
};

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
};

export const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};
