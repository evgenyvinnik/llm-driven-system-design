/**
 * @fileoverview Authentication middleware for Express routes.
 * Provides session validation and role-based access control.
 */

import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/authService.js';
import type { User } from '../types/index.js';

/**
 * Extends Express Request type to include authenticated user and session.
 */
declare global {
  namespace Express {
    interface Request {
      /** Authenticated user object, present after successful authentication */
      user?: User;
      /** Session ID from the request, used for logout */
      sessionId?: string;
    }
  }
}

/**
 * Middleware that requires valid authentication.
 * Extracts session ID from Authorization header or cookies.
 * Returns 401 if not authenticated.
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware function
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionId;

  if (!sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await authService.validateSession(sessionId);

  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.user = user;
  req.sessionId = sessionId;
  next();
}

/**
 * Middleware that optionally authenticates if session is present.
 * Does not reject unauthenticated requests.
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware function
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionId;

  if (sessionId) {
    const user = await authService.validateSession(sessionId);
    if (user) {
      req.user = user;
      req.sessionId = sessionId;
    }
  }

  next();
}

/**
 * Creates middleware that requires specific user roles.
 * Must be used after authenticate middleware.
 * @param roles - Allowed roles (e.g., 'admin', 'developer')
 * @returns Middleware function that checks user role
 */
export function requireRole(...roles: User['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

/**
 * Middleware that requires developer or admin role.
 * Convenience wrapper for developer-only endpoints.
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware function
 */
export function requireDeveloper(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'developer' && req.user.role !== 'admin') {
    res.status(403).json({ error: 'Developer account required' });
    return;
  }

  next();
}

/**
 * Middleware that requires admin role.
 * Use for administrative endpoints like user management.
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware function
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}
