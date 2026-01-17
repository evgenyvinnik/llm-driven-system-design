import logger from '../services/logger.js';

/**
 * Authentication and Authorization Middleware
 *
 * Implements session-based authentication with Role-Based Access Control (RBAC).
 *
 * Roles:
 * - anonymous: No authentication, can view public content
 * - user: Regular authenticated user, can create content, follow, like, comment
 * - verified: Verified user (blue checkmark), same as user but with verified badge
 * - admin: Full access, can moderate content and manage users
 *
 * Session stored in Valkey/Redis with structure:
 * {
 *   userId: UUID,
 *   username: string,
 *   role: 'user' | 'verified' | 'admin',
 *   isVerified: boolean,
 *   createdAt: ISO timestamp,
 *   expiresAt: ISO timestamp
 * }
 */

// Role hierarchy: higher number = more permissions
const ROLE_LEVELS = {
  anonymous: 0,
  user: 1,
  verified: 2,
  admin: 3,
};

/**
 * Check if user has required role level
 * @param {string} userRole - User's current role
 * @param {string} requiredRole - Minimum required role
 * @returns {boolean} True if user has sufficient permissions
 */
const hasPermission = (userRole, requiredRole) => {
  const userLevel = ROLE_LEVELS[userRole] || 0;
  const requiredLevel = ROLE_LEVELS[requiredRole] || 0;
  return userLevel >= requiredLevel;
};

/**
 * Require authentication middleware
 * Denies access if user is not logged in
 */
export const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    logger.debug({
      type: 'auth',
      result: 'denied',
      reason: 'not_authenticated',
      path: req.path,
      ip: req.ip,
    }, 'Authentication required');
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

/**
 * Require admin role middleware
 * Only allows admin users to proceed
 */
export const requireAdmin = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    logger.debug({
      type: 'auth',
      result: 'denied',
      reason: 'not_authenticated',
      path: req.path,
    }, 'Authentication required for admin access');
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.session.role !== 'admin') {
    logger.warn({
      type: 'auth',
      result: 'denied',
      reason: 'insufficient_role',
      userRole: req.session.role,
      requiredRole: 'admin',
      userId: req.session.userId,
      path: req.path,
    }, `Admin access denied for user ${req.session.userId}`);
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
};

/**
 * Require verified user role middleware
 * Only allows verified or admin users to proceed
 */
export const requireVerified = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!hasPermission(req.session.role, 'verified')) {
    logger.debug({
      type: 'auth',
      result: 'denied',
      reason: 'not_verified',
      userRole: req.session.role,
      userId: req.session.userId,
      path: req.path,
    }, `Verified access denied for user ${req.session.userId}`);
    return res.status(403).json({ error: 'Verified account required' });
  }

  next();
};

/**
 * Require minimum role middleware factory
 * Creates middleware that requires at least the specified role
 *
 * @param {string} minimumRole - Minimum role required ('user', 'verified', 'admin')
 * @returns {Function} Express middleware
 */
export const requireRole = (minimumRole) => {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!hasPermission(req.session.role, minimumRole)) {
      logger.warn({
        type: 'auth',
        result: 'denied',
        reason: 'insufficient_role',
        userRole: req.session.role,
        requiredRole: minimumRole,
        userId: req.session.userId,
        path: req.path,
      }, `Role ${minimumRole} required, user has ${req.session.role}`);
      return res.status(403).json({
        error: `${minimumRole.charAt(0).toUpperCase() + minimumRole.slice(1)} access required`,
      });
    }

    next();
  };
};

/**
 * Optional auth middleware
 * Adds user info if logged in, but doesn't require it
 * Useful for endpoints that work for both anonymous and authenticated users
 */
export const optionalAuth = (req, res, next) => {
  // Session info is already available if user is logged in via express-session
  // This middleware just ensures we don't block unauthenticated requests
  next();
};

/**
 * Resource ownership middleware factory
 * Checks if the current user owns a resource or is an admin
 *
 * @param {Function} getOwnerId - Async function that takes req and returns owner user ID
 * @returns {Function} Express middleware
 */
export const requireOwnership = (getOwnerId) => {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const ownerId = await getOwnerId(req);

      if (!ownerId) {
        return res.status(404).json({ error: 'Resource not found' });
      }

      const isOwner = req.session.userId === ownerId;
      const isAdmin = req.session.role === 'admin';

      if (!isOwner && !isAdmin) {
        logger.warn({
          type: 'auth',
          result: 'denied',
          reason: 'not_owner',
          userId: req.session.userId,
          ownerId,
          path: req.path,
        }, `Ownership denied: ${req.session.userId} tried to access resource owned by ${ownerId}`);
        return res.status(403).json({ error: 'Not authorized to access this resource' });
      }

      req.isResourceOwner = isOwner;
      req.resourceOwnerId = ownerId;
      next();
    } catch (error) {
      logger.error({
        type: 'auth',
        error: error.message,
        path: req.path,
      }, 'Error checking resource ownership');
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
};

/**
 * Admin or self middleware
 * Allows access if user is admin or accessing their own data
 *
 * @param {string} userIdParam - Request param name containing user ID (default: 'userId')
 * @returns {Function} Express middleware
 */
export const requireAdminOrSelf = (userIdParam = 'userId') => {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const targetUserId = req.params[userIdParam];
    const isSelf = req.session.userId === targetUserId;
    const isAdmin = req.session.role === 'admin';

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    req.isSelf = isSelf;
    next();
  };
};

/**
 * Attach user context middleware
 * Adds additional user context to request for logging and metrics
 */
export const attachUserContext = (req, res, next) => {
  if (req.session?.userId) {
    req.userContext = {
      userId: req.session.userId,
      username: req.session.username,
      role: req.session.role || 'user',
      isVerified: req.session.isVerified || false,
    };
  } else {
    req.userContext = {
      role: 'anonymous',
    };
  }
  next();
};

export default {
  requireAuth,
  requireAdmin,
  requireVerified,
  requireRole,
  optionalAuth,
  requireOwnership,
  requireAdminOrSelf,
  attachUserContext,
  ROLE_LEVELS,
};
