/**
 * Role-Based Access Control (RBAC) Middleware.
 *
 * Implements authorization based on user roles and permissions.
 * Provides fine-grained access control for different user types.
 *
 * Role Hierarchy:
 * - viewer: Standard subscriber (browse, watch, manage own profiles)
 * - kids_viewer: Kids profile (browse/watch kids content only)
 * - account_owner: Primary account holder (all viewer + billing, profiles)
 * - admin: Netflix staff (content management, experiments, analytics)
 * - content_admin: Content team (upload videos, edit metadata)
 * - experiment_admin: Data science (A/B tests, experiment results)
 *
 * This module also handles:
 * - Profile-level isolation (users can only access their own profiles)
 * - Maturity-based content filtering
 * - Resource ownership validation
 */
import { Request, Response, NextFunction } from 'express';
import { queryOne } from '../db/index.js';
import { authLogger } from '../services/logger.js';
import { Session } from '../services/redis.js';

/**
 * User roles in the system.
 */
export type UserRole =
  | 'viewer'
  | 'kids_viewer'
  | 'account_owner'
  | 'admin'
  | 'content_admin'
  | 'experiment_admin';

/**
 * Extends Express Request type for RBAC.
 */
declare global {
  namespace Express {
    interface Request {
      userRole?: UserRole;
      isAdmin?: boolean;
    }
  }
}

/**
 * Extends Session type to include role information.
 */
export interface SessionWithRole extends Session {
  role?: UserRole;
}

/**
 * Role permissions mapping.
 * Defines what each role is allowed to do.
 */
const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  viewer: [
    'browse:read',
    'videos:read',
    'profiles:read',
    'profiles:write:own',
    'streaming:read',
    'streaming:write:progress',
    'mylist:read',
    'mylist:write',
  ],
  kids_viewer: [
    'browse:read:kids',
    'videos:read:kids',
    'profiles:read:own',
    'streaming:read:kids',
  ],
  account_owner: [
    // All viewer permissions
    'browse:read',
    'videos:read',
    'profiles:read',
    'profiles:write:own',
    'streaming:read',
    'streaming:write:progress',
    'mylist:read',
    'mylist:write',
    // Additional owner permissions
    'profiles:write:all',
    'profiles:create',
    'profiles:delete',
    'account:read',
    'account:write',
    'billing:read',
    'billing:write',
  ],
  admin: [
    '*', // Full access
  ],
  content_admin: [
    'browse:read',
    'videos:read',
    'videos:write',
    'videos:create',
    'videos:delete',
    'content:read',
    'content:write',
    'content:upload',
  ],
  experiment_admin: [
    'browse:read',
    'videos:read',
    'experiments:read',
    'experiments:write',
    'experiments:create',
    'experiments:delete',
    'analytics:read',
  ],
};

/**
 * Admin roles that have elevated privileges.
 */
const ADMIN_ROLES: UserRole[] = ['admin', 'content_admin', 'experiment_admin'];

/**
 * Checks if a role has a specific permission.
 *
 * @param role - User role to check
 * @param permission - Permission string (e.g., 'videos:write')
 * @returns True if the role has the permission
 */
function hasPermission(role: UserRole, permission: string): boolean {
  const permissions = ROLE_PERMISSIONS[role];

  // Check for wildcard (full access)
  if (permissions.includes('*')) {
    return true;
  }

  // Check for exact permission
  if (permissions.includes(permission)) {
    return true;
  }

  // Check for parent permission (e.g., 'videos:read' grants 'videos:read:kids')
  const parts = permission.split(':');
  for (let i = parts.length - 1; i > 0; i--) {
    const parentPermission = parts.slice(0, i).join(':');
    if (permissions.includes(parentPermission)) {
      return true;
    }
  }

  return false;
}

/**
 * Determines the effective role for a request.
 * Considers profile settings (e.g., kids profile).
 *
 * @param req - Express request with session
 * @returns User role
 */
async function determineRole(req: Request): Promise<UserRole> {
  // Check if role is already in session
  const session = req.session as SessionWithRole | undefined;
  if (session?.role) {
    return session.role;
  }

  // Default role for authenticated users
  let role: UserRole = 'viewer';

  // Check if account is an admin
  if (req.accountId) {
    const account = await queryOne<{ is_admin: boolean; role: string }>(
      `SELECT is_admin, role FROM accounts WHERE id = $1`,
      [req.accountId]
    );

    if (account?.is_admin || account?.role === 'admin') {
      role = 'admin';
    } else if (account?.role && ROLE_PERMISSIONS[account.role as UserRole]) {
      role = account.role as UserRole;
    }
  }

  // Check if using a kids profile
  if (req.profileId && role === 'viewer') {
    const profile = await queryOne<{ is_kids: boolean }>(
      'SELECT is_kids FROM profiles WHERE id = $1',
      [req.profileId]
    );

    if (profile?.is_kids) {
      role = 'kids_viewer';
    }
  }

  return role;
}

/**
 * Middleware to attach user role to request.
 * Should be used after authentication middleware.
 */
export async function attachRole(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (req.accountId) {
    req.userRole = await determineRole(req);
    req.isAdmin = ADMIN_ROLES.includes(req.userRole);
  }
  next();
}

/**
 * Creates middleware that requires specific roles.
 *
 * @param allowedRoles - Array of roles that can access the endpoint
 * @returns Express middleware function
 *
 * @example
 * router.post('/admin/videos', requireRole('admin', 'content_admin'), (req, res) => { ... });
 */
export function requireRole(
  ...allowedRoles: UserRole[]
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userRole = req.userRole || (await determineRole(req));
    req.userRole = userRole;
    req.isAdmin = ADMIN_ROLES.includes(userRole);

    if (!allowedRoles.includes(userRole)) {
      authLogger.warn({
        accountId: req.accountId,
        profileId: req.profileId,
        userRole,
        requiredRoles: allowedRoles,
        path: req.path,
      }, 'Access denied - insufficient role');

      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to access this resource',
        required: allowedRoles,
        current: userRole,
      });
      return;
    }

    next();
  };
}

/**
 * Creates middleware that requires specific permission.
 *
 * @param permission - Required permission string
 * @returns Express middleware function
 *
 * @example
 * router.put('/videos/:id', requirePermission('videos:write'), (req, res) => { ... });
 */
export function requirePermission(
  permission: string
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userRole = req.userRole || (await determineRole(req));
    req.userRole = userRole;
    req.isAdmin = ADMIN_ROLES.includes(userRole);

    if (!hasPermission(userRole, permission)) {
      authLogger.warn({
        accountId: req.accountId,
        profileId: req.profileId,
        userRole,
        requiredPermission: permission,
        path: req.path,
      }, 'Access denied - insufficient permission');

      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to perform this action',
        required: permission,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to require admin access.
 * Shorthand for requireRole with all admin roles.
 */
export const requireAdmin = requireRole('admin', 'content_admin', 'experiment_admin');

/**
 * Middleware that validates profile ownership.
 * Ensures users can only access their own profiles.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function validateProfileOwnership(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { profileId } = req.params;

  if (!profileId) {
    next();
    return;
  }

  // Admins can access any profile
  if (req.isAdmin) {
    next();
    return;
  }

  // Verify profile belongs to the account
  const profile = await queryOne<{ account_id: string }>(
    'SELECT account_id FROM profiles WHERE id = $1',
    [profileId]
  );

  if (!profile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  if (profile.account_id !== req.accountId) {
    authLogger.warn({
      accountId: req.accountId,
      profileId,
      profileOwnerId: profile.account_id,
    }, 'Profile ownership validation failed');

    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  next();
}

/**
 * Middleware that applies maturity-based content filtering.
 * Filters content based on the profile's maturity level.
 */
export async function applyMaturityFilter(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  // Skip for admins
  if (req.isAdmin) {
    next();
    return;
  }

  if (req.profileId) {
    const profile = await queryOne<{ maturity_level: number; is_kids: boolean }>(
      'SELECT maturity_level, is_kids FROM profiles WHERE id = $1',
      [req.profileId]
    );

    if (profile) {
      // Attach maturity level to request for use in queries
      (req as Request & { maturityLevel?: number }).maturityLevel = profile.maturity_level;

      // For kids profiles, enforce maximum maturity level
      if (profile.is_kids) {
        (req as Request & { maturityLevel?: number }).maturityLevel = 1;
      }
    }
  }

  next();
}

/**
 * Creates middleware that validates resource ownership.
 * Generic middleware for validating ownership of any resource.
 *
 * @param tableName - Database table name
 * @param idParam - Request parameter containing resource ID
 * @param ownerColumn - Column name containing owner ID (default: 'account_id')
 * @returns Express middleware function
 */
export function validateOwnership(
  tableName: string,
  idParam: string,
  ownerColumn = 'account_id'
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const resourceId = req.params[idParam];

    if (!resourceId) {
      next();
      return;
    }

    // Admins can access any resource
    if (req.isAdmin) {
      next();
      return;
    }

    const resource = await queryOne<Record<string, unknown>>(
      `SELECT ${ownerColumn} FROM ${tableName} WHERE id = $1`,
      [resourceId]
    );

    if (!resource) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    if (resource[ownerColumn] !== req.accountId) {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }

    next();
  };
}

/**
 * Gets the list of permissions for a role.
 *
 * @param role - User role
 * @returns Array of permission strings
 */
export function getPermissionsForRole(role: UserRole): string[] {
  return ROLE_PERMISSIONS[role] || [];
}

/**
 * Checks if a user has admin privileges.
 *
 * @param role - User role
 * @returns True if user is an admin
 */
export function isAdminRole(role: UserRole): boolean {
  return ADMIN_ROLES.includes(role);
}
