/**
 * Authentication and authorization middleware.
 * Implements session-based auth with RBAC for user vs admin operations.
 *
 * @module middleware/auth
 */
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/**
 * User roles in the system.
 */
export type UserRole = 'user' | 'recruiter' | 'admin';

/**
 * Permission definitions for each role.
 */
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  user: [
    'profile:read',
    'profile:write:own',
    'connection:read',
    'connection:write',
    'feed:read',
    'feed:write',
    'job:read',
    'job:apply',
    'search:user',
    'search:job',
  ],
  recruiter: [
    'profile:read',
    'profile:write:own',
    'connection:read',
    'connection:write',
    'feed:read',
    'feed:write',
    'job:read',
    'job:apply',
    'job:post',
    'job:manage:own',
    'candidate:search',
    'search:user',
    'search:job',
  ],
  admin: [
    'profile:read',
    'profile:write:own',
    'profile:write:any',
    'connection:read',
    'connection:write',
    'feed:read',
    'feed:write',
    'feed:moderate',
    'job:read',
    'job:apply',
    'job:post',
    'job:manage:any',
    'candidate:search',
    'search:user',
    'search:job',
    'user:manage',
    'user:ban',
    'content:moderate',
    'analytics:view',
    'audit:view',
  ],
};

/**
 * Checks if a role has a specific permission.
 *
 * @param role - User's role
 * @param permission - Permission to check
 * @returns True if role has permission
 */
export function hasPermission(role: UserRole, permission: string): boolean {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes(permission);
}

/**
 * Checks if a user can perform an action on a resource.
 * Handles ownership checks for `:own` permissions.
 *
 * @param role - User's role
 * @param permission - Base permission (e.g., 'profile:write')
 * @param userId - Current user's ID
 * @param resourceOwnerId - Owner of the resource
 * @returns True if action is allowed
 */
export function canPerformAction(
  role: UserRole,
  permission: string,
  userId: number,
  resourceOwnerId: number
): boolean {
  // Check for :any permission first (admins)
  if (hasPermission(role, `${permission}:any`)) {
    return true;
  }

  // Check for :own permission
  if (hasPermission(role, `${permission}:own`)) {
    return userId === resourceOwnerId;
  }

  // Check for general permission
  return hasPermission(role, permission);
}

/**
 * Express middleware that requires a valid authenticated session.
 * Checks for userId in the session and returns 401 if not present.
 * Used to protect routes that require any authenticated user.
 *
 * @param req - Express request object with session
 * @param res - Express response object
 * @param next - Next middleware function
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    logger.debug({ path: req.path }, 'Authentication required but no session');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/**
 * Express middleware that requires admin role in addition to authentication.
 * Returns 401 for unauthenticated requests and 403 for non-admin users.
 * Used to protect admin-only routes like user management and content moderation.
 *
 * @param req - Express request object with session
 * @param res - Express response object
 * @param next - Next middleware function
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    logger.debug({ path: req.path }, 'Admin required but no session');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.session.role !== 'admin') {
    logger.warn(
      { userId: req.session.userId, role: req.session.role, path: req.path },
      'Admin access denied'
    );
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/**
 * Express middleware that requires recruiter or admin role.
 * Used for job posting and candidate management features.
 *
 * @param req - Express request object with session
 * @param res - Express response object
 * @param next - Next middleware function
 */
export function requireRecruiter(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.session.role !== 'recruiter' && req.session.role !== 'admin') {
    logger.warn(
      { userId: req.session.userId, role: req.session.role, path: req.path },
      'Recruiter access denied'
    );
    res.status(403).json({ error: 'Recruiter access required' });
    return;
  }
  next();
}

/**
 * Creates a middleware that requires a specific permission.
 * Supports ownership checks using the resourceIdParam.
 *
 * @param permission - Required permission (e.g., 'profile:write')
 * @param resourceIdParam - Optional request param name for ownership check
 * @returns Express middleware
 */
export function requirePermission(
  permission: string,
  resourceIdParam?: string
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const role = (req.session.role || 'user') as UserRole;

    // If resource ID param is specified, check ownership
    if (resourceIdParam) {
      const resourceId = parseInt(req.params[resourceIdParam]);
      if (!canPerformAction(role, permission, req.session.userId, resourceId)) {
        logger.warn(
          {
            userId: req.session.userId,
            role,
            permission,
            resourceId,
            path: req.path,
          },
          'Permission denied'
        );
        res.status(403).json({ error: 'Permission denied' });
        return;
      }
    } else {
      // No ownership check, just verify permission
      if (!hasPermission(role, permission)) {
        logger.warn(
          { userId: req.session.userId, role, permission, path: req.path },
          'Permission denied'
        );
        res.status(403).json({ error: 'Permission denied' });
        return;
      }
    }

    next();
  };
}

/**
 * Middleware to attach user info to request for logging.
 * Runs after session middleware to enrich request context.
 */
export function attachUserContext(req: Request, res: Response, next: NextFunction): void {
  if (req.session.userId) {
    // Attach user info for logging and metrics
    (req as Request & { userContext: Record<string, unknown> }).userContext = {
      userId: req.session.userId,
      role: req.session.role || 'user',
    };
  }
  next();
}

/**
 * Middleware to check resource ownership.
 * Used when updating or deleting user-owned resources.
 *
 * @param getOwnerId - Function to get the owner ID from the request
 * @returns Express middleware
 */
export function requireOwnership(
  getOwnerId: (req: Request) => Promise<number | null>
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session.userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Admins bypass ownership check
    if (req.session.role === 'admin') {
      next();
      return;
    }

    const ownerId = await getOwnerId(req);
    if (ownerId === null) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    if (ownerId !== req.session.userId) {
      logger.warn(
        { userId: req.session.userId, ownerId, path: req.path },
        'Ownership check failed'
      );
      res.status(403).json({ error: 'Permission denied' });
      return;
    }

    next();
  };
}
