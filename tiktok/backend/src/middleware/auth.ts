import { Request, Response, NextFunction } from 'express';
import { createLogger, auditLog } from '../shared/logger.js';

const logger = createLogger('auth');

// Extend Express Session to include user properties
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    username?: string;
    role?: string;
  }
}

/**
 * User roles with hierarchical permissions
 *
 * Hierarchy: admin > moderator > creator > user (viewer)
 *
 * - user (viewer): Can watch videos, like, comment, follow
 * - creator: All user permissions + can upload videos
 * - moderator: All creator permissions + can moderate content and users
 * - admin: All permissions including system configuration
 */
export const ROLES = {
  USER: 'user',
  CREATOR: 'creator',
  MODERATOR: 'moderator',
  ADMIN: 'admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

// Role hierarchy (higher index = more permissions)
const ROLE_HIERARCHY: Role[] = [ROLES.USER, ROLES.CREATOR, ROLES.MODERATOR, ROLES.ADMIN];

/**
 * Permission definitions
 */
export const PERMISSIONS = {
  // Video permissions
  VIDEO_VIEW: 'video:view',
  VIDEO_UPLOAD: 'video:upload',
  VIDEO_DELETE_OWN: 'video:delete:own',
  VIDEO_DELETE_ANY: 'video:delete:any',
  VIDEO_MODERATE: 'video:moderate',

  // Comment permissions
  COMMENT_CREATE: 'comment:create',
  COMMENT_DELETE_OWN: 'comment:delete:own',
  COMMENT_DELETE_ANY: 'comment:delete:any',

  // User permissions
  USER_FOLLOW: 'user:follow',
  USER_VIEW_PROFILE: 'user:view:profile',
  USER_EDIT_OWN: 'user:edit:own',
  USER_BAN: 'user:ban',
  USER_MANAGE_ROLES: 'user:manage:roles',

  // Analytics permissions
  ANALYTICS_VIEW_OWN: 'analytics:view:own',
  ANALYTICS_VIEW_ALL: 'analytics:view:all',

  // Admin permissions
  ADMIN_ACCESS: 'admin:access',
  ADMIN_CONFIG: 'admin:config',
  ADMIN_AUDIT: 'admin:audit',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Role-permission mapping
 */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [ROLES.USER]: [
    PERMISSIONS.VIDEO_VIEW,
    PERMISSIONS.COMMENT_CREATE,
    PERMISSIONS.COMMENT_DELETE_OWN,
    PERMISSIONS.USER_FOLLOW,
    PERMISSIONS.USER_VIEW_PROFILE,
    PERMISSIONS.USER_EDIT_OWN,
  ],
  [ROLES.CREATOR]: [
    PERMISSIONS.VIDEO_VIEW,
    PERMISSIONS.COMMENT_CREATE,
    PERMISSIONS.COMMENT_DELETE_OWN,
    PERMISSIONS.USER_FOLLOW,
    PERMISSIONS.USER_VIEW_PROFILE,
    PERMISSIONS.USER_EDIT_OWN,
    PERMISSIONS.VIDEO_UPLOAD,
    PERMISSIONS.VIDEO_DELETE_OWN,
    PERMISSIONS.ANALYTICS_VIEW_OWN,
  ],
  [ROLES.MODERATOR]: [
    PERMISSIONS.VIDEO_VIEW,
    PERMISSIONS.COMMENT_CREATE,
    PERMISSIONS.COMMENT_DELETE_OWN,
    PERMISSIONS.USER_FOLLOW,
    PERMISSIONS.USER_VIEW_PROFILE,
    PERMISSIONS.USER_EDIT_OWN,
    PERMISSIONS.VIDEO_UPLOAD,
    PERMISSIONS.VIDEO_DELETE_OWN,
    PERMISSIONS.ANALYTICS_VIEW_OWN,
    PERMISSIONS.VIDEO_DELETE_ANY,
    PERMISSIONS.VIDEO_MODERATE,
    PERMISSIONS.COMMENT_DELETE_ANY,
    PERMISSIONS.USER_BAN,
    PERMISSIONS.ANALYTICS_VIEW_ALL,
    PERMISSIONS.ADMIN_ACCESS,
  ],
  [ROLES.ADMIN]: Object.values(PERMISSIONS) as Permission[],
};

/**
 * Check if a role has a specific permission
 */
export const hasPermission = (role: string, permission: string): boolean => {
  const permissions = ROLE_PERMISSIONS[role as Role] || [];
  return permissions.includes(permission as Permission);
};

/**
 * Check if roleA is higher or equal to roleB in hierarchy
 */
export const isRoleAtLeast = (userRole: string, requiredRole: string): boolean => {
  const userIndex = ROLE_HIERARCHY.indexOf(userRole as Role);
  const requiredIndex = ROLE_HIERARCHY.indexOf(requiredRole as Role);
  return userIndex >= requiredIndex;
};

/**
 * Basic authentication middleware - requires any authenticated user
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.session?.userId) {
    logger.debug({ path: req.path }, 'Authentication required but no session');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
};

/**
 * Optional authentication - continues regardless of auth status
 */
export const optionalAuth = (_req: Request, _res: Response, next: NextFunction): void => {
  // User might be authenticated or not - we continue either way
  next();
};

/**
 * Role-based access control middleware
 * Requires user to have one of the specified roles
 *
 * @param roles - Allowed roles
 */
export const requireRole = (
  ...roles: string[]
): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      logger.debug({ path: req.path }, 'Authentication required');
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRole = req.session.role || ROLES.USER;

    if (!roles.includes(userRole)) {
      logger.warn(
        {
          userId: req.session.userId,
          userRole,
          requiredRoles: roles,
          path: req.path,
        },
        'Insufficient role permissions'
      );

      auditLog('access_denied', req.session.userId, {
        reason: 'insufficient_role',
        requiredRoles: roles,
        userRole,
        path: req.path,
      });

      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

/**
 * Require minimum role level (uses hierarchy)
 *
 * @param minimumRole - Minimum required role
 */
export const requireMinRole = (
  minimumRole: string
): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRole = req.session.role || ROLES.USER;

    if (!isRoleAtLeast(userRole, minimumRole)) {
      logger.warn(
        {
          userId: req.session.userId,
          userRole,
          minimumRole,
          path: req.path,
        },
        'Insufficient role level'
      );

      auditLog('access_denied', req.session.userId, {
        reason: 'insufficient_role_level',
        minimumRole,
        userRole,
        path: req.path,
      });

      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

/**
 * Permission-based access control middleware
 *
 * @param permissions - Required permissions (user needs at least one)
 */
export const requirePermission = (
  ...permissions: string[]
): ((req: Request, res: Response, next: NextFunction) => void) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRole = req.session.role || ROLES.USER;
    const hasAnyPermission = permissions.some((perm) => hasPermission(userRole, perm));

    if (!hasAnyPermission) {
      logger.warn(
        {
          userId: req.session.userId,
          userRole,
          requiredPermissions: permissions,
          path: req.path,
        },
        'Missing required permissions'
      );

      auditLog('access_denied', req.session.userId, {
        reason: 'missing_permission',
        requiredPermissions: permissions,
        userRole,
        path: req.path,
      });

      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

/**
 * Require admin access
 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.session.role !== ROLES.ADMIN) {
    logger.warn(
      {
        userId: req.session.userId,
        userRole: req.session.role,
        path: req.path,
      },
      'Admin access required'
    );

    auditLog('access_denied', req.session.userId, {
      reason: 'admin_required',
      path: req.path,
    });

    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
};

/**
 * Require moderator or admin access
 */
export const requireModerator = requireMinRole(ROLES.MODERATOR);

/**
 * Require creator, moderator, or admin access
 */
export const requireCreator = requireMinRole(ROLES.CREATOR);

/**
 * Resource ownership check middleware factory
 * Checks if user owns the resource or has override permission
 *
 * @param getOwnerId - Async function to get owner ID from request
 * @param overridePermission - Permission that bypasses ownership check
 */
export const requireOwnershipOr = (
  getOwnerId: (req: Request) => Promise<number>,
  overridePermission: string
): ((req: Request, res: Response, next: NextFunction) => Promise<void>) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session?.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userRole = req.session.role || ROLES.USER;

    // Check if user has override permission
    if (hasPermission(userRole, overridePermission)) {
      next();
      return;
    }

    // Check ownership
    try {
      const ownerId = await getOwnerId(req);
      if (ownerId === req.session.userId) {
        next();
        return;
      }

      logger.warn(
        {
          userId: req.session.userId,
          ownerId,
          path: req.path,
        },
        'Resource ownership check failed'
      );

      res.status(403).json({ error: 'Not authorized to access this resource' });
      return;
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Error checking resource ownership');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
  };
};

/**
 * Attach user role to session if missing (for legacy sessions)
 */
export const ensureRole = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  if (req.session?.userId && !req.session.role) {
    // Default to 'user' role if not set
    req.session.role = ROLES.USER;
  }
  next();
};

export default {
  ROLES,
  PERMISSIONS,
  hasPermission,
  isRoleAtLeast,
  requireAuth,
  optionalAuth,
  requireRole,
  requireMinRole,
  requirePermission,
  requireAdmin,
  requireModerator,
  requireCreator,
  requireOwnershipOr,
  ensureRole,
};
