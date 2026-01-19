import type { Response, NextFunction } from 'express';
import { getSession } from '../redis.js';
import { query } from '../db.js';
import type { AuthenticatedRequest, User } from '../types.js';

export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const token = req.cookies?.session_token || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const userId = await getSession(token);

    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const result = await query('SELECT id, username, email, role FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = result.rows[0] as User;
    req.sessionToken = token;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const token = req.cookies?.session_token || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    next();
    return;
  }

  try {
    const userId = await getSession(token);

    if (userId) {
      const result = await query('SELECT id, username, email, role FROM users WHERE id = $1', [userId]);

      if (result.rows.length > 0) {
        req.user = result.rows[0] as User;
        req.sessionToken = token;
      }
    }
  } catch (error) {
    console.error('Optional auth error:', error);
  }

  next();
};

export const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};
