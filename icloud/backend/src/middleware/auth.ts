import type { Request, Response, NextFunction } from 'express';
import { pool, redis } from '../db.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  storageQuota: number;
  storageUsed: number;
}

// Extend Express Request to include user and deviceId
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      deviceId?: string;
    }
  }
}

export interface SessionData {
  user: AuthenticatedUser;
  deviceId: string;
}

/**
 * Reads the session token from the `session_token` cookie or a Bearer header.
 * The WebSocket upgrade uses this too, so both paths accept the same credentials.
 */
export function getSessionToken(
  cookies: Record<string, string> | undefined,
  authorization: string | undefined
): string | undefined {
  return cookies?.session_token || authorization?.replace('Bearer ', '') || undefined;
}

/**
 * Resolves a session token to its user and device: Redis first, then the
 * sessions table (re-cached for 5 minutes). Returns null for an unknown or
 * expired token. Login only writes the sessions table, so the database
 * fallback is what makes a fresh session usable before any REST call.
 */
export async function resolveSession(token: string): Promise<SessionData | null> {
  const cachedSession = await redis.get(`session:${token}`);

  if (cachedSession) {
    return JSON.parse(cachedSession) as SessionData;
  }

  const result = await pool.query(
    `SELECT s.*, u.id as user_id, u.email, u.role, u.storage_quota, u.storage_used
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const session: SessionData = {
    user: {
      id: row.user_id,
      email: row.email,
      role: row.role,
      storageQuota: row.storage_quota,
      storageUsed: row.storage_used,
    },
    deviceId: row.device_id,
  };

  // Cache session in Redis (expire in 5 minutes)
  await redis.setex(`session:${token}`, 300, JSON.stringify(session));

  return session;
}

/** Validates session token from cookie or Authorization header, caches in Redis for 5 minutes. */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = getSessionToken(req.cookies, req.headers.authorization);

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const session = await resolveSession(token);

    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = session.user;
    req.deviceId = session.deviceId;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

/** Restricts access to admin users only, returns 403 for non-admin roles. */
export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
