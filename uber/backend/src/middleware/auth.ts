import type { Response, NextFunction } from 'express';
import authService from '../services/authService.js';
import type { AuthenticatedRequest, User } from '../types/index.js';

// Request interface with optional user (before authentication)
interface RequestWithOptionalUser extends AuthenticatedRequest {
  user: User;
  token: string;
}

// Authentication middleware
export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await authService.validateSession(token);

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.user = user;
  req.token = token;
  next();
}

// Require rider role
export function requireRider(
  req: RequestWithOptionalUser,
  res: Response,
  next: NextFunction
): void {
  if (req.user.userType !== 'rider') {
    res.status(403).json({ error: 'Rider access required' });
    return;
  }
  next();
}

// Require driver role
export function requireDriver(
  req: RequestWithOptionalUser,
  res: Response,
  next: NextFunction
): void {
  if (req.user.userType !== 'driver') {
    res.status(403).json({ error: 'Driver access required' });
    return;
  }
  next();
}
