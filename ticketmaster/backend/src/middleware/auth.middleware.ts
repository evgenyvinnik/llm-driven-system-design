import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userRole?: string;
  sessionId?: string;
}

export const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const sessionId = req.cookies?.session || req.headers['x-session-id'] as string;

  if (!sessionId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const session = await authService.validateSession(sessionId);
  if (!session) {
    res.status(401).json({ success: false, error: 'Invalid or expired session' });
    return;
  }

  req.userId = session.userId;
  req.userRole = session.role;
  req.sessionId = sessionId;

  next();
};

export const adminMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.userRole !== 'admin') {
    res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }
  next();
};

export const optionalAuthMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const sessionId = req.cookies?.session || req.headers['x-session-id'] as string;

  if (sessionId) {
    const session = await authService.validateSession(sessionId);
    if (session) {
      req.userId = session.userId;
      req.userRole = session.role;
      req.sessionId = sessionId;
    }
  }

  next();
};
