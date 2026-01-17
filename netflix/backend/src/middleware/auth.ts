import { Request, Response, NextFunction } from 'express';
import { getSession, Session } from '../services/redis.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      session?: Session;
      accountId?: string;
      profileId?: string;
    }
  }
}

/**
 * Authentication middleware - validates session token from cookie
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.cookies?.session_token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const session = await getSession(token);

  if (!session) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.session = session;
  req.accountId = session.accountId;
  req.profileId = session.profileId;

  next();
}

/**
 * Optional authentication - sets session info if available but doesn't require it
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.cookies?.session_token;

  if (token) {
    const session = await getSession(token);
    if (session) {
      req.session = session;
      req.accountId = session.accountId;
      req.profileId = session.profileId;
    }
  }

  next();
}

/**
 * Requires a profile to be selected
 */
export async function requireProfile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.profileId) {
    res.status(400).json({ error: 'Profile selection required' });
    return;
  }

  next();
}
