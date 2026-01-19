import type { Request, Response, NextFunction } from 'express';
import { getSession } from '../services/auth.js';
import { query } from '../db.js';
import type { UserPublic } from '../types/index.js';

interface UserRow {
  id: number;
  email: string;
  name: string;
  avatar_url: string | null;
  is_host: boolean;
  is_verified: boolean;
  role: 'user' | 'admin';
}

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const session = await getSession(sessionId);

    if (!session) {
      res.clearCookie('session');
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    // Get user from database
    const result = await query<UserRow>(
      'SELECT id, email, name, avatar_url, is_host, is_verified, role FROM users WHERE id = $1',
      [session.userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    next();
    return;
  }

  try {
    const session = await getSession(sessionId);

    if (session) {
      const result = await query<UserRow>(
        'SELECT id, email, name, avatar_url, is_host, is_verified, role FROM users WHERE id = $1',
        [session.userId]
      );

      if (result.rows.length > 0) {
        req.user = result.rows[0];
      }
    }
  } catch (error) {
    console.error('Optional auth error:', error);
  }

  next();
};

export const requireHost = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (!req.user?.is_host) {
    res.status(403).json({ error: 'Must be a host to access this resource' });
    return;
  }
  next();
};

export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};
