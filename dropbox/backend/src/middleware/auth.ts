import { Request, Response, NextFunction } from 'express';
import { getSession } from '../utils/redis.js';
import { queryOne } from '../utils/database.js';
import { User } from '../types/index.js';

export interface AuthRequest extends Request {
  user?: User;
  token?: string;
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // Get token from Authorization header or cookie
    let token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      token = req.cookies?.token;
    }

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Check Redis for session
    const userId = await getSession(token);

    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    // Get user from database
    const user = await queryOne<User>(
      `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM users WHERE id = $1`,
      [userId]
    );

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
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

// Optional auth - continues even without token
export async function optionalAuthMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    let token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      token = req.cookies?.token;
    }

    if (token) {
      const userId = await getSession(token);

      if (userId) {
        const user = await queryOne<User>(
          `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes",
                  created_at as "createdAt", updated_at as "updatedAt"
           FROM users WHERE id = $1`,
          [userId]
        );

        if (user) {
          req.user = user;
          req.token = token;
        }
      }
    }

    next();
  } catch (error) {
    console.error('Optional auth error:', error);
    next();
  }
}
