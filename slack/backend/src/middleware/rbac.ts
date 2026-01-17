/**
 * @fileoverview Role-Based Access Control (RBAC) middleware for workspace authorization.
 * Enforces role hierarchy for workspace operations: owner > admin > member > guest.
 *
 * WHY RBAC:
 * - Enables workspace isolation - users can only access workspaces they belong to
 * - Provides granular permission control - admins can manage channels but not delete workspace
 * - Simplifies authorization checks - single middleware handles all role-based restrictions
 * - Supports multi-tenancy - each workspace has independent role assignments
 */

import { Request, Response, NextFunction } from 'express';
import { query } from '../db/index.js';
import { logger } from '../services/logger.js';

/**
 * Workspace roles in order of increasing privilege.
 * Higher roles inherit all permissions of lower roles.
 */
export type WorkspaceRole = 'guest' | 'member' | 'admin' | 'owner';

/**
 * Numeric hierarchy for role comparison.
 * Higher number = more privileges.
 */
const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * Permission definitions by role.
 * Explicitly lists what each role can do for clarity.
 */
export const PERMISSIONS = {
  // Read operations
  READ_PUBLIC_CHANNELS: ['guest', 'member', 'admin', 'owner'],
  READ_PRIVATE_CHANNELS: ['member', 'admin', 'owner'], // If member of channel

  // Message operations
  SEND_MESSAGES: ['guest', 'member', 'admin', 'owner'],
  EDIT_OWN_MESSAGES: ['guest', 'member', 'admin', 'owner'],
  DELETE_OWN_MESSAGES: ['guest', 'member', 'admin', 'owner'],
  DELETE_ANY_MESSAGE: ['admin', 'owner'],

  // Channel operations
  CREATE_CHANNEL: ['member', 'admin', 'owner'],
  UPDATE_CHANNEL: ['admin', 'owner'],
  ARCHIVE_CHANNEL: ['admin', 'owner'],
  DELETE_CHANNEL: ['owner'],

  // Member operations
  INVITE_MEMBERS: ['admin', 'owner'],
  REMOVE_MEMBERS: ['admin', 'owner'],
  CHANGE_MEMBER_ROLE: ['owner'],

  // Workspace operations
  UPDATE_WORKSPACE_SETTINGS: ['owner'],
  DELETE_WORKSPACE: ['owner'],
  VIEW_AUDIT_LOG: ['admin', 'owner'],
  MANAGE_INTEGRATIONS: ['admin', 'owner'],
} as const;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Extended session data with workspace membership info.
 */
interface WorkspaceMembership {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  joined_at: Date;
}

/**
 * Extended Express Request with membership data.
 */
declare global {
  namespace Express {
    interface Request {
      membership?: WorkspaceMembership;
    }
  }
}

/**
 * Middleware that requires a minimum role for workspace operations.
 * Fetches the user's role in the current workspace and compares to the required role.
 *
 * @param minRole - The minimum role required to access this route
 * @returns Express middleware function
 *
 * @example
 * // Only admins and owners can access this route
 * router.delete('/channels/:id', requireRole('admin'), deleteChannel);
 */
export function requireRole(minRole: WorkspaceRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const workspaceId = req.session.workspaceId || req.params.workspaceId;
    const userId = req.session.userId;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace context required' });
      return;
    }

    try {
      // Fetch user's membership and role in the workspace
      const result = await query<WorkspaceMembership>(
        'SELECT workspace_id, user_id, role, joined_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId]
      );

      if (result.rows.length === 0) {
        res.status(403).json({ error: 'Not a member of this workspace' });
        return;
      }

      const membership = result.rows[0];
      const userRoleLevel = ROLE_HIERARCHY[membership.role as WorkspaceRole] ?? 0;
      const requiredRoleLevel = ROLE_HIERARCHY[minRole];

      if (userRoleLevel < requiredRoleLevel) {
        logger.warn({
          msg: 'Insufficient permissions',
          userId,
          workspaceId,
          userRole: membership.role,
          requiredRole: minRole,
        });
        res.status(403).json({
          error: 'Insufficient permissions',
          required: minRole,
          current: membership.role,
        });
        return;
      }

      // Attach membership to request for use in route handlers
      req.membership = membership;
      next();
    } catch (error) {
      logger.error({ err: error, msg: 'RBAC middleware error' });
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

/**
 * Middleware that checks if the user has a specific permission.
 * More granular than role checks - allows for permission-based access control.
 *
 * @param permission - The specific permission required
 * @returns Express middleware function
 *
 * @example
 * // Only users with DELETE_ANY_MESSAGE permission can access
 * router.delete('/messages/:id/admin', requirePermission('DELETE_ANY_MESSAGE'), adminDeleteMessage);
 */
export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const workspaceId = req.session.workspaceId || req.params.workspaceId;
    const userId = req.session.userId;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace context required' });
      return;
    }

    try {
      const result = await query<WorkspaceMembership>(
        'SELECT workspace_id, user_id, role, joined_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId]
      );

      if (result.rows.length === 0) {
        res.status(403).json({ error: 'Not a member of this workspace' });
        return;
      }

      const membership = result.rows[0];
      const allowedRoles = PERMISSIONS[permission] as readonly string[];

      if (!allowedRoles.includes(membership.role)) {
        logger.warn({
          msg: 'Permission denied',
          userId,
          workspaceId,
          userRole: membership.role,
          permission,
        });
        res.status(403).json({
          error: 'Permission denied',
          required: permission,
          allowedRoles,
        });
        return;
      }

      req.membership = membership;
      next();
    } catch (error) {
      logger.error({ err: error, msg: 'Permission check error' });
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

/**
 * Middleware that loads membership without enforcing a minimum role.
 * Useful for routes that need membership info but allow all roles.
 *
 * @returns Express middleware function
 */
export function loadMembership() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const workspaceId = req.session.workspaceId || req.params.workspaceId;
    const userId = req.session.userId;

    if (!userId || !workspaceId) {
      next();
      return;
    }

    try {
      const result = await query<WorkspaceMembership>(
        'SELECT workspace_id, user_id, role, joined_at FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId]
      );

      if (result.rows.length > 0) {
        req.membership = result.rows[0];
      }

      next();
    } catch (error) {
      logger.error({ err: error, msg: 'Load membership error' });
      next();
    }
  };
}

/**
 * Helper to check if a user's role meets a minimum requirement.
 * Use this in route handlers when you need conditional logic based on role.
 *
 * @param userRole - The user's current role
 * @param minRole - The minimum required role
 * @returns true if user has sufficient privileges
 */
export function hasMinimumRole(userRole: WorkspaceRole, minRole: WorkspaceRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole];
}

/**
 * Helper to check if a user has a specific permission.
 *
 * @param userRole - The user's current role
 * @param permission - The permission to check
 * @returns true if user has the permission
 */
export function hasPermission(userRole: WorkspaceRole, permission: Permission): boolean {
  const allowedRoles = PERMISSIONS[permission] as readonly string[];
  return allowedRoles.includes(userRole);
}
