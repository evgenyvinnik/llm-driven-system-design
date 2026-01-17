import { Request, Response, NextFunction } from 'express';
import { type User } from '../types/index.js';

// Extend Express Session
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    user?: User;
  }
}

/**
 * Require authentication middleware
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
    return;
  }
  next();
}

/**
 * Require admin role middleware
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
    return;
  }

  if (req.session.user?.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Admin access required',
    });
    return;
  }

  next();
}

/**
 * Optional auth - attaches user if available but doesn't require it
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  // Just pass through - session info will be available if user is logged in
  next();
}
