// Authentication and authorization middleware with RBAC
import { pool } from '../db.js';
import logger from '../shared/logger.js';
import { authEventsTotal } from '../shared/metrics.js';

/**
 * User roles and their hierarchy.
 * Higher values have more permissions.
 */
export const Roles = {
  USER: 'user',
  PREMIUM: 'premium',
  ARTIST: 'artist',
  ADMIN: 'admin',
};

/**
 * Role hierarchy for permission checks.
 * Admin has all permissions, premium extends user, etc.
 */
const roleHierarchy = {
  [Roles.USER]: 1,
  [Roles.PREMIUM]: 2,
  [Roles.ARTIST]: 3,
  [Roles.ADMIN]: 4,
};

/**
 * Cache for user roles (short TTL to avoid stale permissions).
 * In production, use Redis with proper invalidation.
 */
const roleCache = new Map();
const ROLE_CACHE_TTL = 60000; // 1 minute

/**
 * Get user role from database (with caching).
 */
async function getUserRole(userId) {
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

    const user = result.rows[0];
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
    logger.error({ error, userId }, 'Failed to get user role');
    return null;
  }
}

/**
 * Clear role cache for a user (call after role changes).
 */
export function clearRoleCache(userId) {
  roleCache.delete(`role:${userId}`);
}

/**
 * Require authentication middleware.
 * Attaches user info to request.
 */
export function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    authEventsTotal.inc({ event: 'unauthorized', success: 'false' });
    return res.status(401).json({ error: 'Authentication required' });
  }

  // User is authenticated
  next();
}

/**
 * Optional authentication middleware.
 * Continues whether or not user is authenticated.
 */
export function optionalAuth(req, res, next) {
  // Just continue - session may or may not have userId
  next();
}

/**
 * Require specific role(s) middleware factory.
 * Checks if user has one of the specified roles.
 *
 * @param {...string} roles - Required roles (user must have at least one)
 */
export function requireRole(...roles) {
  return async (req, res, next) => {
    // First check authentication
    if (!req.session || !req.session.userId) {
      authEventsTotal.inc({ event: 'unauthorized', success: 'false' });
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = await getUserRole(req.session.userId);

    if (!userRole) {
      authEventsTotal.inc({ event: 'role_check_failed', success: 'false' });
      return res.status(401).json({ error: 'User not found' });
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
      const log = req.log || logger;
      log.warn(
        {
          userId: req.session.userId,
          userRole,
          requiredRoles: roles,
        },
        'Insufficient permissions'
      );
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Attach role to request for use in handlers
    req.userRole = userRole;
    next();
  };
}

/**
 * Require minimum role level middleware factory.
 * Uses role hierarchy for comparison.
 *
 * @param {string} minimumRole - Minimum required role level
 */
export function requireMinRole(minimumRole) {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      authEventsTotal.inc({ event: 'unauthorized', success: 'false' });
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userRole = await getUserRole(req.session.userId);

    if (!userRole) {
      authEventsTotal.inc({ event: 'role_check_failed', success: 'false' });
      return res.status(401).json({ error: 'User not found' });
    }

    const userLevel = roleHierarchy[userRole] || 0;
    const requiredLevel = roleHierarchy[minimumRole] || 0;

    if (userLevel < requiredLevel) {
      authEventsTotal.inc({ event: 'forbidden', success: 'false' });
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    req.userRole = userRole;
    next();
  };
}

/**
 * Require admin role middleware.
 * Convenience wrapper for requireRole(Roles.ADMIN).
 */
export function requireAdmin(req, res, next) {
  return requireRole(Roles.ADMIN)(req, res, next);
}

/**
 * Require premium subscription middleware.
 * Allows premium users and admins.
 */
export function requirePremium(req, res, next) {
  return requireRole(Roles.PREMIUM, Roles.ADMIN)(req, res, next);
}

/**
 * Check if user can access a resource.
 * Helper for resource-level authorization.
 *
 * @param {string} userId - User making the request
 * @param {string} ownerId - Owner of the resource
 * @param {string} userRole - Role of the user
 */
export function canAccessResource(userId, ownerId, userRole) {
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
