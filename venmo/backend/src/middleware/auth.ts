import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool.js';
import { getSession } from '../db/redis.js';

export interface User {
  id: string;
  username: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
}

export interface AuthenticatedRequest extends Request {
  user: User;
  sessionId: string;
  requestId?: string;
  idempotencyKey?: string;
  idempotencyFailed?: boolean;
  storeIdempotencyResult?: (status: string, response: unknown) => Promise<void>;
}

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const sessionId = req.headers['x-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    // Get user details
    const result = await pool.query(
      'SELECT id, username, email, name, avatar_url, role FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    (req as AuthenticatedRequest).user = result.rows[0];
    (req as AuthenticatedRequest).sessionId = sessionId;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

export const adminMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if ((req as AuthenticatedRequest).user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};
