/**
 * @fileoverview Access control and permissions for collaborative documents.
 * @description Handles checking and determining document permissions before allowing
 * collaboration. Provides functions to verify ownership and shared access rights.
 * @module services/collaboration/permissions
 */

import pool from '../../utils/db.js';
import { PERMISSION_CAPABILITIES } from '../../shared/rbac.js';
import type { PermissionLevel } from '../../types/index.js';

/**
 * Result of a document permission check.
 *
 * @interface PermissionCheckResult
 * @property {boolean} found - Whether the document exists and is not deleted
 * @property {string} [ownerId] - UUID of the document owner (if found)
 * @property {number} [currentVersion] - Current version number of the document (if found)
 * @property {unknown} [content] - Current document content (if found)
 * @property {string} [permissionLevel] - Permission level granted to the user ('view', 'comment', 'edit') or undefined if none
 *
 * @example
 * // Document found, user has edit permission
 * const result: PermissionCheckResult = {
 *   found: true,
 *   ownerId: 'owner-123',
 *   currentVersion: 42,
 *   content: { type: 'doc', content: [...] },
 *   permissionLevel: 'edit',
 * };
 *
 * @example
 * // Document not found or deleted
 * const result: PermissionCheckResult = { found: false };
 */
export interface PermissionCheckResult {
  found: boolean;
  ownerId?: string;
  currentVersion?: number;
  content?: unknown;
  permissionLevel?: string;
}

/**
 * Checks if a user has permission to access a document.
 *
 * @description Queries the database to verify the document exists and retrieves
 * the user's permission level. Returns document details if the document is found,
 * regardless of whether the user has access (access check is done separately).
 *
 * @param {string} documentId - UUID of the document to check
 * @param {string} userId - UUID of the user requesting access
 * @returns {Promise<PermissionCheckResult>} Object containing document details and permission info
 *
 * @example
 * const result = await checkDocumentPermission('doc-456', 'user-123');
 * if (!result.found) {
 *   return res.status(404).json({ error: 'Document not found' });
 * }
 * if (!hasAccess(userId, result.ownerId, result.permissionLevel)) {
 *   return res.status(403).json({ error: 'Access denied' });
 * }
 */
export async function checkDocumentPermission(
  documentId: string,
  userId: string
): Promise<PermissionCheckResult> {
  const permCheck = await pool.query(
    `SELECT d.owner_id, d.current_version, d.content, dp.permission_level
     FROM documents d
     LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
     WHERE d.id = $1 AND d.is_deleted = false`,
    [documentId, userId]
  );

  if (permCheck.rows.length === 0) {
    return { found: false };
  }

  const { owner_id, current_version, content, permission_level } = permCheck.rows[0];

  return {
    found: true,
    ownerId: owner_id,
    // BIGINT arrives from pg as a string; the version counter is a number everywhere else.
    currentVersion: Number(current_version),
    content,
    permissionLevel: permission_level,
  };
}

/**
 * Determines if a user has access to a document based on ownership or permission.
 *
 * @description Returns true if the user is the document owner OR has been granted
 * any permission level (view, comment, or edit). Used to gate access to documents.
 *
 * @param {string} userId - UUID of the user to check
 * @param {string} ownerId - UUID of the document owner
 * @param {string | null} permissionLevel - Permission level granted to user, or null if none
 * @returns {boolean} True if user has access, false otherwise
 *
 * @example
 * // Owner always has access
 * hasAccess('user-123', 'user-123', null); // true
 *
 * // User with explicit permission
 * hasAccess('user-456', 'user-123', 'view'); // true
 *
 * // User without permission
 * hasAccess('user-789', 'user-123', null); // false
 */
export function hasAccess(userId: string, ownerId: string, permissionLevel: string | null): boolean {
  return ownerId === userId || !!permissionLevel;
}

/**
 * Gets the effective permission level for a user on a document.
 *
 * @description Owners always have 'edit' permission. For non-owners, returns their
 * granted permission level or 'none' if they have no explicit permission.
 *
 * @param {string} userId - UUID of the user
 * @param {string} ownerId - UUID of the document owner
 * @param {string | null} permissionLevel - Permission level granted to user, or null if none
 * @returns {string} Effective permission: 'edit' for owners, granted level for others, or 'none'
 *
 * @example
 * // Owner gets edit permission
 * getEffectivePermission('user-123', 'user-123', null); // 'edit'
 *
 * // Shared user gets their granted level
 * getEffectivePermission('user-456', 'user-123', 'view'); // 'view'
 *
 * // No permission granted
 * getEffectivePermission('user-789', 'user-123', null); // 'none'
 */
export function getEffectivePermission(
  userId: string,
  ownerId: string,
  permissionLevel: string | null
): string {
  return ownerId === userId ? 'edit' : (permissionLevel || 'none');
}

/** Permission levels a document_permissions row can grant ('owner' is not a grant). */
const GRANT_LEVELS = new Set<string>(['view', 'comment', 'edit']);

/**
 * Determines if a user may send edit operations to a document.
 *
 * @description Uses the same capability table as the REST RBAC middleware
 * (`requireEdit` in shared/rbac.ts): owners and 'edit' grants may edit, while
 * 'comment' and 'view' grants are read-only on the collaboration channel too.
 *
 * @param {boolean} isOwner - Whether the user owns the document
 * @param {string | null | undefined} permissionLevel - Permission level granted to user, if any
 * @returns {boolean} True if the user may edit the document's content
 *
 * @example
 * canEditDocument(true, null);       // true  (owner)
 * canEditDocument(false, 'edit');    // true
 * canEditDocument(false, 'comment'); // false
 * canEditDocument(false, null);      // false
 */
export function canEditDocument(isOwner: boolean, permissionLevel: string | null | undefined): boolean {
  if (isOwner) return PERMISSION_CAPABILITIES.owner.canEdit;
  if (!permissionLevel || !GRANT_LEVELS.has(permissionLevel)) return false;
  return PERMISSION_CAPABILITIES[permissionLevel as PermissionLevel].canEdit;
}

