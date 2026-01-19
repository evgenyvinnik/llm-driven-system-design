import { Request, Response, NextFunction } from 'express';
import { authService, User } from '../services/authService.js';

// Extend Express Request to include user and token
declare global {
  namespace Express {
    interface Request {
      user?: User;
      token?: string;
      requestId?: string;
      log?: import('pino').Logger;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No authentication token provided' });
      return;
    }

    const token = authHeader.substring(7);
    const userId = await authService.validateSession(token);

    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const user = await authService.getUser(userId);
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

export function adminMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
