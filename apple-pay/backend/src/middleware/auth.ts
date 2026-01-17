import { Request, Response, NextFunction } from 'express';
import redis from '../db/redis.js';
import { query } from '../db/index.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  deviceId?: string;
  userRole?: 'user' | 'admin';
}

export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const sessionId = req.headers['x-session-id'] as string;

  if (!sessionId) {
    return res.status(401).json({ error: 'No session provided' });
  }

  try {
    const sessionData = await redis.get(`session:${sessionId}`);
    if (!sessionData) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const session = JSON.parse(sessionData);
    req.userId = session.userId;
    req.deviceId = session.deviceId;
    req.userRole = session.role;

    // Refresh session TTL
    await redis.expire(`session:${sessionId}`, 3600);

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

export async function adminMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export async function biometricMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const biometricSessionId = req.headers['x-biometric-session'] as string;

  if (!biometricSessionId) {
    return res.status(401).json({ error: 'Biometric verification required' });
  }

  try {
    const result = await query(
      `SELECT * FROM biometric_sessions
       WHERE id = $1 AND user_id = $2 AND status = 'verified'
       AND expires_at > NOW()`,
      [biometricSessionId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired biometric session' });
    }

    next();
  } catch (error) {
    console.error('Biometric middleware error:', error);
    return res.status(500).json({ error: 'Biometric verification error' });
  }
}
