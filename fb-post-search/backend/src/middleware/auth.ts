import type { Request, Response, NextFunction } from 'express';
import { validateSession } from '../services/authService.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userRole?: string;
}

// Optional authentication - sets user info if token present
export async function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;

  if (token) {
    try {
      const session = await validateSession(token);
      if (session) {
        req.userId = session.userId;
        req.userRole = session.role;
      }
    } catch (error) {
      // Token invalid, continue as anonymous
    }
  }

  next();
}

// Required authentication - returns 401 if not authenticated
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const session = await validateSession(token);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.userId = session.userId;
    req.userRole = session.role;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
}

// Admin only - requires admin role
export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const session = await validateSession(token);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    if (session.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    req.userId = session.userId;
    req.userRole = session.role;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Authentication failed' });
  }
}
