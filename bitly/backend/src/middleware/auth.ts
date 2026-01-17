import { Request, Response, NextFunction } from 'express';
import { getUserByToken } from '../services/authService.js';
import { AUTH_CONFIG } from '../config.js';
import { UserPublic } from '../models/types.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
    }
  }
}

// Optional authentication - attaches user if present
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = req.cookies?.[AUTH_CONFIG.cookieName] || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const user = await getUserByToken(token);
      if (user) {
        req.user = user;
      }
    }
  } catch (error) {
    // Ignore auth errors for optional auth
  }

  next();
}

// Required authentication - returns 401 if not authenticated
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = req.cookies?.[AUTH_CONFIG.cookieName] || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const user = await getUserByToken(token);

    if (!user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// Admin-only authentication
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = req.cookies?.[AUTH_CONFIG.cookieName] || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const user = await getUserByToken(token);

    if (!user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    if (user.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}
