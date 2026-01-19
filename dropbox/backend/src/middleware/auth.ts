/**
 * Authentication and authorization middleware for Express routes.
 * Provides session-based authentication, admin role checking,
 * and Role-Based Access Control (RBAC) for file/folder permissions.
 *
 * WHY RBAC enables file sharing permissions:
 * - File owners need full control (delete, share, manage versions)
 * - Editors can modify content but not share or delete
 * - Viewers can only read content
 * - Permissions are inherited through folder hierarchy
 * - Fine-grained access control supports collaboration scenarios
 *
 * @module middleware/auth
 */

import { Request, Response, NextFunction } from 'express';
import { getSession } from '../utils/redis.js';
import { queryOne, query } from '../utils/database.js';
import { User, FileItem, FolderShare } from '../types/index.js';
import { logger } from '../shared/logger.js';

/**
 * Access levels for RBAC.
 * Owner > Editor > Viewer in terms of permissions.
 */
export type AccessLevel = 'owner' | 'editor' | 'viewer';

/**
 * Permission types that can be checked
 */
export type Permission = 'read' | 'write' | 'delete' | 'share' | 'manage';

/**
 * Permission mapping for each access level.
 * Defines what actions each role can perform.
 */
const ROLE_PERMISSIONS: Record<AccessLevel, Permission[]> = {
  owner: ['read', 'write', 'delete', 'share', 'manage'],
  editor: ['read', 'write'],
  viewer: ['read'],
};

/**
 * Extended Express Request with user authentication and RBAC data.
 * Routes using auth middleware will have user and token properties available.
 * Routes using RBAC middleware will have accessLevel property.
 */
export interface AuthRequest extends Request {
  user?: User;
  token?: string;
  traceId?: string;
  /** Access level for the resource being accessed */
  accessLevel?: AccessLevel;
  /** Target file/folder being accessed */
  targetItem?: FileItem;
}

/**
 * Middleware that requires valid authentication.
 * Extracts token from Authorization header or cookie, validates against Redis,
 * and loads user data from the database. Returns 401 if authentication fails.
 * @param req - Express request (will be populated with user data)
 * @param res - Express response
 * @param next - Next middleware function
 */
export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from Authorization header or cookie
    let token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      token = req.cookies?.token;
    }

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Check Redis for session
    const userId = await getSession(token);

    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    // Get user from database
    const user = await queryOne<User>(
      `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes",
              created_at as "createdAt", updated_at as "updatedAt"
       FROM users WHERE id = $1`,
      [userId]
    );

    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    logger.error({ error }, 'Auth middleware error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Middleware that requires admin role.
 * Must be used after authMiddleware. Returns 403 if user is not an admin.
 * @param req - Express request (must have user from authMiddleware)
 * @param res - Express response
 * @param next - Next middleware function
 */
export async function adminMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (req.user.role !== 'admin') {
    logger.warn(
      { userId: req.user.id, path: req.path },
      'Non-admin user attempted admin access'
    );
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  next();
}

/**
 * Middleware that attempts authentication but continues without it.
 * Useful for routes that work for both authenticated and anonymous users
 * (e.g., shared file access where auth provides additional context).
 * @param req - Express request (may be populated with user data if authenticated)
 * @param res - Express response
 * @param next - Next middleware function
 */
export async function optionalAuthMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      token = req.cookies?.token;
    }

    if (token) {
      const userId = await getSession(token);

      if (userId) {
        const user = await queryOne<User>(
          `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes",
                  created_at as "createdAt", updated_at as "updatedAt"
           FROM users WHERE id = $1`,
          [userId]
        );

        if (user) {
          req.user = user;
          req.token = token;
        }
      }
    }

    next();
  } catch (error) {
    logger.error({ error }, 'Optional auth error');
    next();
  }
}

// ============================================================================
// RBAC (Role-Based Access Control) Middleware
// ============================================================================

/**
 * Determines the access level a user has for a file/folder.
 * Walks up the folder hierarchy checking ownership and shares.
 *
 * @param userId - ID of the user to check access for
 * @param fileId - ID of the file/folder to check
 * @returns Access level (owner, editor, viewer) or null if no access
 */
export async function getAccessLevel(
  userId: string,
  fileId: string
): Promise<{ level: AccessLevel; item: FileItem } | null> {
  // Get the file/folder
  const item = await queryOne<FileItem>(
    `SELECT id, user_id as "userId", parent_id as "parentId", name, is_folder as "isFolder",
            size, mime_type as "mimeType", content_hash as "contentHash", version,
            sync_status as "syncStatus", created_at as "createdAt", updated_at as "updatedAt"
     FROM files WHERE id = $1 AND deleted_at IS NULL`,
    [fileId]
  );

  if (!item) {
    return null;
  }

  // Check if user is owner
  if (item.userId === userId) {
    return { level: 'owner', item };
  }

  // Check folder shares up the hierarchy
  let currentId: string | null = item.isFolder ? fileId : item.parentId;
  let highestLevel: AccessLevel | null = null;

  while (currentId) {
    const share = await queryOne<{ access_level: string }>(
      `SELECT access_level FROM folder_shares
       WHERE folder_id = $1 AND shared_with = $2`,
      [currentId, userId]
    );

    if (share) {
      const shareLevel: AccessLevel = share.access_level === 'edit' ? 'editor' : 'viewer';

      // Editor is higher than viewer
      if (!highestLevel || (shareLevel === 'editor' && highestLevel === 'viewer')) {
        highestLevel = shareLevel;
      }

      // If we found editor access, that's the highest share level possible
      if (highestLevel === 'editor') {
        break;
      }
    }

    // Move up to parent folder
    const parent = await queryOne<{ parent_id: string | null }>(
      `SELECT parent_id FROM files WHERE id = $1`,
      [currentId]
    );

    currentId = parent?.parent_id || null;
  }

  if (highestLevel) {
    return { level: highestLevel, item };
  }

  return null;
}

/**
 * Checks if an access level has a specific permission.
 * @param accessLevel - The access level to check
 * @param permission - The permission to verify
 * @returns true if the access level has the permission
 */
export function hasPermission(accessLevel: AccessLevel, permission: Permission): boolean {
  return ROLE_PERMISSIONS[accessLevel].includes(permission);
}

/**
 * Factory function to create RBAC middleware for specific permissions.
 * Extracts file ID from route parameters and checks access.
 *
 * @param requiredPermission - Permission required to access the resource
 * @param paramName - Route parameter name containing the file/folder ID (default: 'fileId')
 * @returns Express middleware
 */
export function requirePermission(
  requiredPermission: Permission,
  paramName: string = 'fileId'
) {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const fileId = req.params[paramName] as string;

      if (!fileId) {
        res.status(400).json({ error: `Missing ${paramName} parameter` });
        return;
      }

      const access = await getAccessLevel(req.user.id, fileId);

      if (!access) {
        logger.warn(
          { userId: req.user.id, fileId, permission: requiredPermission },
          'Access denied - no access to resource'
        );
        res.status(404).json({ error: 'Resource not found' });
        return;
      }

      if (!hasPermission(access.level, requiredPermission)) {
        logger.warn(
          { userId: req.user.id, fileId, accessLevel: access.level, requiredPermission },
          'Access denied - insufficient permissions'
        );
        res.status(403).json({
          error: 'Insufficient permissions',
          required: requiredPermission,
          current: access.level,
        });
        return;
      }

      // Attach access info to request for use in handlers
      req.accessLevel = access.level;
      req.targetItem = access.item;

      logger.debug(
        { userId: req.user.id, fileId, accessLevel: access.level },
        'Access granted'
      );

      next();
    } catch (error) {
      logger.error({ error }, 'RBAC middleware error');
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}

/**
 * Convenience middleware: Requires read permission
 */
export const requireRead = requirePermission('read');

/**
 * Convenience middleware: Requires write permission
 */
export const requireWrite = requirePermission('write');

/**
 * Convenience middleware: Requires delete permission
 */
export const requireDelete = requirePermission('delete');

/**
 * Convenience middleware: Requires share permission
 */
export const requireShare = requirePermission('share');

/**
 * Convenience middleware: Requires manage permission (full control)
 */
export const requireManage = requirePermission('manage');

/**
 * Middleware that requires the user to be the owner.
 * Stricter than requireManage - only the actual owner, no admins.
 */
export function requireOwnership(paramName: string = 'fileId') {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const fileId = req.params[paramName] as string;

      if (!fileId) {
        res.status(400).json({ error: `Missing ${paramName} parameter` });
        return;
      }

      const access = await getAccessLevel(req.user.id, fileId);

      if (!access || access.level !== 'owner') {
        logger.warn(
          { userId: req.user.id, fileId },
          'Access denied - ownership required'
        );
        res.status(403).json({ error: 'Owner access required' });
        return;
      }

      req.accessLevel = 'owner';
      req.targetItem = access.item;
      next();
    } catch (error) {
      logger.error({ error }, 'Ownership middleware error');
      res.status(500).json({ error: 'Authorization check failed' });
    }
  };
}
