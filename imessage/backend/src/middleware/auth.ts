import { Response, NextFunction } from 'express';
import { getSession, SessionData } from '../redis.js';
import { query } from '../db.js';
import { LoggedRequest } from '../shared/logger.js';

export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  [key: string]: unknown;
}

export interface AuthenticatedRequest extends LoggedRequest {
  user: User;
  session: SessionData;
  deviceId: string;
}

export interface WsAuthResult {
  user: User;
  session: SessionData;
  deviceId: string;
}

export async function authenticateRequest(
  req: LoggedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' });
      return;
    }

    const token = authHeader.substring(7);
    const session = await getSession(token);

    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    // Get user details
    const result = await query<User>(
      'SELECT id, username, email, display_name, avatar_url FROM users WHERE id = $1',
      [session.userId]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const authReq = req as AuthenticatedRequest;
    authReq.user = result.rows[0];
    authReq.session = session;
    authReq.deviceId = session.deviceId;

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function authenticateWs(token: string | null): Promise<WsAuthResult | null> {
  if (!token) {
    return null;
  }

  const session = await getSession(token);
  if (!session) {
    return null;
  }

  const result = await query<User>(
    'SELECT id, username, email, display_name, avatar_url FROM users WHERE id = $1',
    [session.userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    user: result.rows[0],
    session,
    deviceId: session.deviceId,
  };
}
