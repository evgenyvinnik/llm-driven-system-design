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

/** Validates the session via the x-session-id header and attaches the user object. */
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

/**
 * Asserts the authenticated user is a member of the given group. Returns the
 * membership row (with role) or null. Callers 403 when this returns null —
 * group data (expenses, balances) must never leak to non-members.
 */
export const getGroupMembership = async (
  groupId: string,
  userId: string
): Promise<{ role: string } | null> => {
  const result = await pool.query<{ role: string }>(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0] || null;
};
