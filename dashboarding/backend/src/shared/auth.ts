/**
 * @fileoverview Session-based authentication and RBAC middleware.
 *
 * Provides:
 * - Session-based authentication using Redis-backed sessions
 * - Role-Based Access Control (RBAC) for authorization
 * - Request context enrichment with user information
 *
 * Roles:
 * - viewer: Can view dashboards and query metrics (read-only)
 * - editor: Can create/edit own dashboards, create alerts
 * - admin: Full access including user management and system config
 *
 * WHY RBAC enables dashboard sharing:
 * RBAC separates authorization from authentication, allowing fine-grained
 * control over who can view vs edit dashboards. Viewers can see shared
 * dashboards without risk of accidental modifications, while editors
 * maintain control over their own content. This separation enables
 * safe sharing across teams while protecting dashboard integrity.
 */

import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import pool from '../db/pool.js';
import logger from './logger.js';
import type { User } from '../types/index.js';

/**
 * User roles in order of privilege (lowest to highest).
 */
export const ROLES = ['viewer', 'editor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Permission definitions for each role.
 * Each role inherits permissions from lower roles.
 */
const ROLE_PERMISSIONS: Record<Role, string[]> = {
  viewer: [
    'dashboard:read',
    'panel:read',
    'metrics:query',
    'alerts:read',
  ],
  editor: [
    // Inherits viewer permissions
    'dashboard:read',
    'panel:read',
    'metrics:query',
    'alerts:read',
    // Additional editor permissions
    'dashboard:create',
    'dashboard:update:own',
    'dashboard:delete:own',
    'panel:create',
    'panel:update:own',
    'panel:delete:own',
    'alerts:create',
    'alerts:update:own',
    'alerts:delete:own',
    'metrics:ingest',
  ],
  admin: [
    // Inherits all permissions
    'dashboard:read',
    'panel:read',
    'metrics:query',
    'alerts:read',
    'dashboard:create',
    'dashboard:update:own',
    'dashboard:delete:own',
    'panel:create',
    'panel:update:own',
    'panel:delete:own',
    'alerts:create',
    'alerts:update:own',
    'alerts:delete:own',
    'metrics:ingest',
    // Admin-only permissions
    'dashboard:update:any',
    'dashboard:delete:any',
    'panel:update:any',
    'panel:delete:any',
    'alerts:update:any',
    'alerts:delete:any',
    'users:read',
    'users:create',
    'users:update',
    'users:delete',
    'system:admin',
  ],
};

/**
 * Checks if a role has a specific permission.
 *
 * @param role - The user's role
 * @param permission - The permission to check
 * @returns true if the role has the permission
 */
export function hasPermission(role: Role, permission: string): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Checks if a role meets the minimum required role level.
 *
 * @param userRole - The user's current role
 * @param requiredRole - The minimum required role
 * @returns true if userRole is at least as privileged as requiredRole
 */
export function hasMinimumRole(userRole: Role, requiredRole: Role): boolean {
  const userIndex = ROLES.indexOf(userRole);
  const requiredIndex = ROLES.indexOf(requiredRole);
  return userIndex >= requiredIndex;
}

/**
 * Authentication middleware that validates session and attaches user to request.
 *
 * If authentication fails:
 * - Returns 401 Unauthorized
 * - Logs the failure reason
 *
 * On success:
 * - Attaches user info to req.session
 * - Allows request to continue to next middleware
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Next middleware function
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.session?.userId;

    if (!userId) {
      logger.debug({ path: req.path }, 'Authentication failed: No session');
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      return;
    }

    // Verify user still exists and is active
    const result = await pool.query<Pick<User, 'id' | 'role'>>(
      'SELECT id, role FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // User deleted or session invalid
      req.session.destroy((err) => {
        if (err) logger.error({ error: err }, 'Failed to destroy invalid session');
      });
      res.status(401).json({ error: 'Unauthorized', message: 'Session invalid' });
      return;
    }

    // Ensure session role matches database (in case of role changes)
    const dbRole = result.rows[0].role as Role;
    if (req.session.role !== dbRole) {
      req.session.role = dbRole;
    }

    next();
  } catch (error) {
    logger.error({ error }, 'Authentication middleware error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Optional authentication middleware that attaches user if session exists.
 *
 * Unlike requireAuth, this does not block unauthenticated requests.
 * Useful for endpoints that behave differently for authenticated users
 * (e.g., showing public dashboards to everyone, but owned dashboards only to owner).
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Next middleware function
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Session is already handled by express-session middleware
  // Just continue to next middleware
  next();
}

/**
 * Factory function that creates RBAC middleware for role-based authorization.
 *
 * @param allowedRoles - Array of roles that can access the endpoint
 * @returns Express middleware function
 *
 * @example
 * // Only admins can access user management
 * router.get('/users', requireAuth, requireRole('admin'), userController.list);
 *
 * // Editors and admins can create dashboards
 * router.post('/dashboards', requireAuth, requireRole('editor', 'admin'), dashboardController.create);
 */
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = req.session?.role as Role | undefined;

    if (!userRole) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      return;
    }

    if (!allowedRoles.includes(userRole)) {
      logger.warn(
        {
          userId: req.session?.userId,
          userRole,
          requiredRoles: allowedRoles,
          path: req.path,
          method: req.method,
        },
        'Authorization failed: Insufficient role'
      );

      res.status(403).json({
        error: 'Forbidden',
        message: `Insufficient permissions. Required role: ${allowedRoles.join(' or ')}`,
      });
      return;
    }

    next();
  };
}

/**
 * Factory function that creates permission-based authorization middleware.
 *
 * @param permission - The required permission string
 * @returns Express middleware function
 *
 * @example
 * // Only users with dashboard:delete:any permission
 * router.delete('/dashboards/:id', requireAuth, requirePermission('dashboard:delete:any'), dashboardController.delete);
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = req.session?.role as Role | undefined;

    if (!userRole) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      return;
    }

    if (!hasPermission(userRole, permission)) {
      logger.warn(
        {
          userId: req.session?.userId,
          userRole,
          requiredPermission: permission,
          path: req.path,
          method: req.method,
        },
        'Authorization failed: Missing permission'
      );

      res.status(403).json({
        error: 'Forbidden',
        message: `Missing required permission: ${permission}`,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to check if user owns a resource OR has admin privileges.
 *
 * Use this for endpoints where users can modify their own resources,
 * but admins can modify any resource.
 *
 * @param getResourceOwnerId - Async function that retrieves the owner ID of the resource
 * @returns Express middleware function
 *
 * @example
 * router.put('/dashboards/:id',
 *   requireAuth,
 *   requireOwnerOrAdmin(async (req) => {
 *     const dashboard = await getDashboard(req.params.id);
 *     return dashboard?.user_id;
 *   }),
 *   dashboardController.update
 * );
 */
export function requireOwnerOrAdmin(
  getResourceOwnerId: (req: Request) => Promise<string | null | undefined>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.session?.userId;
      const userRole = req.session?.role as Role | undefined;

      if (!userId || !userRole) {
        res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
        return;
      }

      // Admins can access any resource
      if (userRole === 'admin') {
        next();
        return;
      }

      // Check ownership
      const ownerId = await getResourceOwnerId(req);

      if (ownerId === null || ownerId === undefined) {
        // Resource not found or has no owner (public resource)
        next();
        return;
      }

      if (ownerId !== userId) {
        logger.warn(
          {
            userId,
            ownerId,
            path: req.path,
            method: req.method,
          },
          'Authorization failed: Not resource owner'
        );

        res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have permission to modify this resource',
        });
        return;
      }

      next();
    } catch (error) {
      logger.error({ error }, 'Owner check middleware error');
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

/**
 * Hashes a password using bcrypt.
 *
 * @param password - Plain text password
 * @returns Promise resolving to the hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Verifies a password against a bcrypt hash.
 *
 * @param password - Plain text password to verify
 * @param hash - The bcrypt hash to compare against
 * @returns Promise resolving to true if password matches
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export default {
  requireAuth,
  optionalAuth,
  requireRole,
  requirePermission,
  requireOwnerOrAdmin,
  hasPermission,
  hasMinimumRole,
  hashPassword,
  verifyPassword,
  ROLES,
};
