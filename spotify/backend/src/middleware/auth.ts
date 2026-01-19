// Authentication and authorization middleware with RBAC
import type { Response, NextFunction, RequestHandler } from 'express';
import { pool } from '../db.js';
import logger from '../shared/logger.js';
import { authEventsTotal } from '../shared/metrics.js';
import type { AuthenticatedRequest, RoleCacheEntry } from '../types.js';

/**
 * User roles and their hierarchy.
 * Higher values have more permissions.
 */
export const Roles = {
  USER: 'user',
  PREMIUM: 'premium',
  ARTIST: 'artist',
  ADMIN: 'admin',
} as const;

export type Role = typeof Roles[keyof typeof Roles];

/**
 * Role hierarchy for permission checks.
 * Admin has all permissions, premium extends user, etc.
 */
const roleHierarchy: Record<string, number> = {
  [Roles.USER]: 1,
  [Roles.PREMIUM]: 2,
  [Roles.ARTIST]: 3,
  [Roles.ADMIN]: 4,
};

/**
 * Cache for user roles (short TTL to avoid stale permissions).
 * In production, use Redis with proper invalidation.
 */
const roleCache = new Map<string, RoleCacheEntry>();
const ROLE_CACHE_TTL = 60000; // 1 minute

/**
 * Get user role from database (with caching).
 */
async function getUserRole(userId: string): Promise<string | null> {
  const cacheKey = `role:${userId}`;
  const cached = roleCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.role;
  }

  try {
    const result = await pool.query(
      'SELECT role, is_premium FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0] as { role?: string; is_premium: boolean };
    // Determine effective role (premium is a special case)
    let role = user.role || Roles.USER;
    if (user.is_premium && role === Roles.USER) {
      role = Roles.PREMIUM;
    }

    // Cache the role
    roleCache.set(cacheKey, {
      role,
      expiresAt: Date.now() + ROLE_CACHE_TTL,
    });

    return role;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage, userId }, 'Failed to get user role');
    return null;
  }
}

/**
 * Clear role cache for a user (call after role changes).
 */
export function clearRoleCache(userId: string): void {
  roleCache.delete(`role:${userId}`);
}

/**
 * Require authentication middleware.
 * Attaches user info to request.
 */
export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.session || !req.session.userId) {
    authEventsTotal.inc({ event: 'unauthorized', success: 'false' });
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // User is authenticated
  next();
}

/**
 * Optional authentication middleware.
 * Continues whether or not user is authenticated.
 */
export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // Just continue - session may or may not have userId
  next();
}

/**
 * Require specific role(s) middleware factory.
 * Checks if user has one of the specified roles.
 */
export function requireRole(...roles: string[]): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    // First check authentication
    if (!authReq.session || !authReq.session.userId) {
      authEventsTotal.inc({ event: 'unauthorized', success: 'false' });
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRole = await getUserRole(authReq.session.userId);

    if (!userRole) {
      authEventsTotal.inc({ event: 'role_check_failed', success: 'false' });
      res.status(401).json({ error: 'User not found' });
      return;
    }

    // Check if user has one of the required roles
    const hasRole = roles.some((role) => {
      // Admin has access to everything
      if (userRole === Roles.ADMIN) return true;
      // Exact role match
      if (userRole === role) return true;
      // Premium users have user role
      if (role === Roles.USER && userRole === Roles.PREMIUM) return true;
      return false;
    });

    if (!hasRole) {
      authEventsTotal.inc({ event: 'forbidden', success: 'false' });
      const log = authReq.log || logger;
      log.warn(
        {
          userId: authReq.session.userId,
          userRole,
          requiredRoles: roles,
        },
        'Insufficient permissions'
      );
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Attach role to request for use in handlers
    authReq.userRole = userRole;
    next();
  };
}

/**
 * Require minimum role level middleware factory.
 * Uses role hierarchy for comparison.
 */
export function requireMinRole(minimumRole: string): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.session || !authReq.session.userId) {
      authEventsTotal.inc({ event: 'unauthorized', success: 'false' });
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRole = await getUserRole(authReq.session.userId);

    if (!userRole) {
      authEventsTotal.inc({ event: 'role_check_failed', success: 'false' });
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const userLevel = roleHierarchy[userRole] || 0;
    const requiredLevel = roleHierarchy[minimumRole] || 0;

    if (userLevel < requiredLevel) {
      authEventsTotal.inc({ event: 'forbidden', success: 'false' });
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    authReq.userRole = userRole;
    next();
  };
}

/**
 * Require admin role middleware.
 * Convenience wrapper for requireRole(Roles.ADMIN).
 */
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  requireRole(Roles.ADMIN)(req, res, next);
}

/**
 * Require premium subscription middleware.
 * Allows premium users and admins.
 */
export function requirePremium(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  requireRole(Roles.PREMIUM, Roles.ADMIN)(req, res, next);
}

/**
 * Check if user can access a resource.
 * Helper for resource-level authorization.
 */
export function canAccessResource(
  userId: string,
  ownerId: string,
  userRole: string
): boolean {
  // Admins can access anything
  if (userRole === Roles.ADMIN) return true;
  // Owner can access their own resources
  if (userId === ownerId) return true;
  return false;
}

export default {
  Roles,
  requireAuth,
  optionalAuth,
  requireRole,
  requireMinRole,
  requireAdmin,
  requirePremium,
  canAccessResource,
  clearRoleCache,
};
