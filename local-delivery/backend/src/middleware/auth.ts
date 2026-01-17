import type { Request, Response, NextFunction } from 'express';
import { getSessionByToken, getUserById } from '../services/authService.js';
import type { User } from '../types/index.js';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
      userId?: string;
    }
  }
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const session = await getSessionByToken(token);

    if (!session) {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
      return;
    }

    const user = await getUserById(session.userId);

    if (!user) {
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }

    req.user = user;
    req.userId = user.id;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

export function requireCustomer(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  return requireRole('customer', 'admin')(req, res, next);
}

export function requireDriver(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  return requireRole('driver', 'admin')(req, res, next);
}

export function requireMerchant(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  return requireRole('merchant', 'admin')(req, res, next);
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  return requireRole('admin')(req, res, next);
}
