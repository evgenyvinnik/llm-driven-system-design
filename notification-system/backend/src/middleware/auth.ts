import { Request, Response, NextFunction } from 'express';
import { query } from '../utils/database.js';
import { redis } from '../utils/redis.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        role: string;
      };
    }
  }
}

interface SessionData {
  user_id: string;
  email: string;
  name: string;
  role: string;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7);

    // Check session in Redis first
    let session: SessionData | null = null;
    const cachedSession = await redis.get(`session:${token}`);

    if (cachedSession) {
      session = JSON.parse(cachedSession) as SessionData;
    } else {
      // Fall back to database
      const result = await query<SessionData>(
        `SELECT s.*, u.email, u.name, u.role
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );

      if (result.rows.length === 0) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }

      session = result.rows[0];

      // Cache in Redis for 5 minutes
      await redis.setex(
        `session:${token}`,
        300,
        JSON.stringify(session)
      );
    }

    req.user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
    };

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
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
