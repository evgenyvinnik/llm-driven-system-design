/**
 * Role-Based Access Control (RBAC) for document permissions.
 *
 * WHY: Document sharing requires granular permissions:
 * - Owner: Full control (edit, share, delete, transfer ownership)
 * - Editor: Edit content, add comments, view history
 * - Commenter: Add comments and suggestions, view content
 * - Viewer: Read-only access to content and comments
 *
 * This enables collaborative workflows where different team members
 * have appropriate levels of access.
 */

import { Request, Response, NextFunction } from 'express';
import pool from '../utils/db.js';
import logger from './logger.js';
import type { PermissionLevel } from '../types/index.js';

/**
 * Extended permission info including role relationship to document.
 */
export interface DocumentAccess {
  isOwner: boolean;
  permissionLevel: PermissionLevel | null;
  effectiveRole: 'owner' | 'editor' | 'commenter' | 'viewer' | null;
}

/**
 * Maps permission levels to their capabilities.
 */
export const PERMISSION_CAPABILITIES = {
  owner: {
    canView: true,
    canComment: true,
    canEdit: true,
    canShare: true,
    canDelete: true,
    canTransferOwnership: true,
  },
  edit: {
    canView: true,
    canComment: true,
    canEdit: true,
    canShare: false,
    canDelete: false,
    canTransferOwnership: false,
  },
  comment: {
    canView: true,
    canComment: true,
    canEdit: false,
    canShare: false,
    canDelete: false,
    canTransferOwnership: false,
  },
  view: {
    canView: true,
    canComment: false,
    canEdit: false,
    canShare: false,
    canDelete: false,
    canTransferOwnership: false,
  },
} as const;

/**
 * Gets the user's access level for a specific document.
 *
 * @param userId - User ID to check
 * @param documentId - Document ID to check access for
 * @returns Access info including ownership and permission level
 */
export async function getDocumentAccess(
  userId: string,
  documentId: string
): Promise<DocumentAccess> {
  const result = await pool.query(
    `SELECT d.owner_id, dp.permission_level
     FROM documents d
     LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
     WHERE d.id = $1 AND d.is_deleted = false`,
    [documentId, userId]
  );

  if (result.rows.length === 0) {
    return { isOwner: false, permissionLevel: null, effectiveRole: null };
  }

  const { owner_id, permission_level } = result.rows[0];
  const isOwner = owner_id === userId;

  let effectiveRole: DocumentAccess['effectiveRole'] = null;
  if (isOwner) {
    effectiveRole = 'owner';
  } else if (permission_level === 'edit') {
    effectiveRole = 'editor';
  } else if (permission_level === 'comment') {
    effectiveRole = 'commenter';
  } else if (permission_level === 'view') {
    effectiveRole = 'viewer';
  }

  return {
    isOwner,
    permissionLevel: permission_level,
    effectiveRole,
  };
}

/**
 * Checks if user has the required capability on a document.
 *
 * @param userId - User ID to check
 * @param documentId - Document ID to check access for
 * @param capability - Required capability (canView, canEdit, etc.)
 * @returns True if user has the capability
 */
export async function checkCapability(
  userId: string,
  documentId: string,
  capability: keyof typeof PERMISSION_CAPABILITIES.owner
): Promise<boolean> {
  const access = await getDocumentAccess(userId, documentId);

  if (!access.effectiveRole) {
    return false;
  }

  if (access.isOwner) {
    return PERMISSION_CAPABILITIES.owner[capability];
  }

  const permLevel = access.permissionLevel;
  if (!permLevel) {
    return false;
  }

  return PERMISSION_CAPABILITIES[permLevel][capability];
}

/**
 * Middleware factory for requiring specific document capabilities.
 * Attaches access info to request for use in handlers.
 *
 * @param capability - Required capability for the route
 * @returns Express middleware that checks the capability
 */
export function requireCapability(
  capability: keyof typeof PERMISSION_CAPABILITIES.owner
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.user?.id;
    const documentId = req.params.id || req.params.documentId;

    if (!userId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }

    if (!documentId) {
      res.status(400).json({ success: false, error: 'Document ID required' });
      return;
    }

    try {
      const access = await getDocumentAccess(userId, documentId);

      // Attach access info to request for use in handler
      (req as Request & { documentAccess?: DocumentAccess }).documentAccess = access;

      if (!access.effectiveRole) {
        res.status(404).json({ success: false, error: 'Document not found or access denied' });
        return;
      }

      const hasCapability = access.isOwner
        ? PERMISSION_CAPABILITIES.owner[capability]
        : access.permissionLevel
          ? PERMISSION_CAPABILITIES[access.permissionLevel][capability]
          : false;

      if (!hasCapability) {
        logger.warn(
          {
            user_id: userId,
            document_id: documentId,
            capability,
            role: access.effectiveRole,
          },
          'Access denied: insufficient permissions'
        );

        const capabilityMessages: Record<string, string> = {
          canView: 'View permission required',
          canComment: 'Comment permission required',
          canEdit: 'Edit permission required',
          canShare: 'Only document owner can share',
          canDelete: 'Only document owner can delete',
          canTransferOwnership: 'Only document owner can transfer ownership',
        };

        res.status(403).json({
          success: false,
          error: capabilityMessages[capability] || 'Permission denied',
        });
        return;
      }

      next();
    } catch (error) {
      logger.error({ error, user_id: userId, document_id: documentId }, 'Error checking permissions');
      res.status(500).json({ success: false, error: 'Failed to check permissions' });
    }
  };
}

/**
 * Convenience middlewares for common capability checks.
 */
export const requireView = requireCapability('canView');
export const requireComment = requireCapability('canComment');
export const requireEdit = requireCapability('canEdit');
export const requireShare = requireCapability('canShare');
export const requireDelete = requireCapability('canDelete');

/**
 * Check if a permission level is valid.
 */
export function isValidPermissionLevel(level: unknown): level is PermissionLevel {
  return typeof level === 'string' && ['view', 'comment', 'edit'].includes(level);
}

export default {
  getDocumentAccess,
  checkCapability,
  requireCapability,
  requireView,
  requireComment,
  requireEdit,
  requireShare,
  requireDelete,
  PERMISSION_CAPABILITIES,
};
