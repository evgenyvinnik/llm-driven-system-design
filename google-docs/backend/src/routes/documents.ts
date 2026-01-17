import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import { idempotency } from '../middleware/idempotency.js';
import { requireEdit, requireShare, requireDelete, getDocumentAccess } from '../shared/rbac.js';
import logger from '../shared/logger.js';
import type { DocumentListItem, DocumentWithPermission, PermissionLevel } from '../types/index.js';

/**
 * Documents router handling CRUD operations for collaborative documents.
 * Manages document ownership, permissions, and sharing functionality.
 * All routes require authentication.
 */
const router = Router();

/**
 * GET /api/documents
 * Lists all documents accessible to the authenticated user.
 * Returns owned documents and documents shared with the user.
 * Excludes soft-deleted documents.
 *
 * @returns {ApiResponse<{documents: DocumentListItem[]}>} List of accessible documents
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const result = await pool.query(
      `SELECT DISTINCT ON (d.id)
        d.id,
        d.title,
        d.owner_id,
        u.name as owner_name,
        u.avatar_color as owner_avatar_color,
        COALESCE(dp.permission_level, CASE WHEN d.owner_id = $1 THEN 'edit' ELSE NULL END) as permission_level,
        d.updated_at,
        d.created_at
       FROM documents d
       JOIN users u ON d.owner_id = u.id
       LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $1
       WHERE (d.owner_id = $1 OR dp.user_id = $1) AND d.is_deleted = false
       ORDER BY d.id, d.updated_at DESC`,
      [userId]
    );

    const documents: DocumentListItem[] = result.rows;

    logger.debug({ userId, documentCount: documents.length }, 'Listed documents');

    res.json({
      success: true,
      data: { documents },
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'List documents error');
    res.status(500).json({ success: false, error: 'Failed to list documents' });
  }
});

/**
 * POST /api/documents
 * Creates a new document with the authenticated user as owner.
 * Initializes document with empty ProseMirror content structure.
 * Creates initial version (version 0) for version history.
 * Supports idempotency via Idempotency-Key header.
 *
 * @param req.body.title - Optional document title (defaults to "Untitled Document")
 * @returns {ApiResponse<{document: Document}>} Newly created document
 */
router.post('/', authenticate, idempotency, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { title } = req.body;

    const defaultContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [],
        },
      ],
    };

    const result = await pool.query(
      `INSERT INTO documents (title, owner_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [title || 'Untitled Document', userId, JSON.stringify(defaultContent)]
    );

    const document = result.rows[0];

    // Create initial version
    await pool.query(
      `INSERT INTO document_versions (document_id, version_number, content, created_by)
       VALUES ($1, $2, $3, $4)`,
      [document.id, 0, JSON.stringify(defaultContent), userId]
    );

    logger.info({ userId, documentId: document.id, title: document.title }, 'Document created');

    res.status(201).json({
      success: true,
      data: { document },
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Create document error');
    res.status(500).json({ success: false, error: 'Failed to create document' });
  }
});

/**
 * GET /api/documents/:id
 * Retrieves a specific document by ID with full content.
 * Checks user has at least view permission (owner or shared).
 * Includes owner information and user's permission level.
 *
 * @param req.params.id - Document UUID
 * @returns {ApiResponse<{document: DocumentWithPermission}>} Document with content and metadata
 */
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;

    const result = await pool.query(
      `SELECT d.*,
        u.name as owner_name,
        u.email as owner_email,
        u.avatar_color as owner_avatar_color,
        COALESCE(dp.permission_level, CASE WHEN d.owner_id = $2 THEN 'edit' ELSE NULL END) as permission_level
       FROM documents d
       JOIN users u ON d.owner_id = u.id
       LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
       WHERE d.id = $1 AND d.is_deleted = false`,
      [documentId, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    const doc = result.rows[0];

    if (!doc.permission_level) {
      logger.warn({ userId, documentId }, 'Access denied to document');
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const document: DocumentWithPermission = {
      id: doc.id,
      title: doc.title,
      owner_id: doc.owner_id,
      current_version: doc.current_version,
      content: doc.content,
      is_deleted: doc.is_deleted,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      permission_level: doc.permission_level,
      owner: {
        id: doc.owner_id,
        email: doc.owner_email,
        name: doc.owner_name,
        avatar_color: doc.owner_avatar_color,
        role: 'user',
      },
    };

    logger.debug({ userId, documentId, permission: doc.permission_level }, 'Document accessed');

    res.json({
      success: true,
      data: { document },
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id, documentId: req.params.id }, 'Get document error');
    res.status(500).json({ success: false, error: 'Failed to get document' });
  }
});

/**
 * PATCH /api/documents/:id
 * Updates document metadata (currently only title).
 * Requires owner or edit permission (enforced by RBAC middleware).
 *
 * @param req.params.id - Document UUID
 * @param req.body.title - New document title
 * @returns {ApiResponse<{document: Document}>} Updated document
 */
router.patch('/:id', authenticate, requireEdit, idempotency, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const { title } = req.body;

    const result = await pool.query(
      `UPDATE documents SET title = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [title, documentId]
    );

    logger.info({ userId, documentId, newTitle: title }, 'Document updated');

    res.json({
      success: true,
      data: { document: result.rows[0] },
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id, documentId: req.params.id }, 'Update document error');
    res.status(500).json({ success: false, error: 'Failed to update document' });
  }
});

/**
 * DELETE /api/documents/:id
 * Soft deletes a document (sets is_deleted flag).
 * Only the document owner can delete (enforced by RBAC middleware).
 * Document remains in database for potential recovery.
 *
 * @param req.params.id - Document UUID
 * @returns {ApiResponse<void>} Success message
 */
router.delete('/:id', authenticate, requireDelete, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;

    await pool.query(
      `UPDATE documents SET is_deleted = true, updated_at = NOW()
       WHERE id = $1`,
      [documentId]
    );

    logger.info({ userId, documentId }, 'Document deleted');

    res.json({
      success: true,
      message: 'Document deleted',
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id, documentId: req.params.id }, 'Delete document error');
    res.status(500).json({ success: false, error: 'Failed to delete document' });
  }
});

/**
 * POST /api/documents/:id/share
 * Shares a document with another user by email.
 * Creates permission record by user_id if user exists, or by email for future users.
 * Only the document owner can share (enforced by RBAC middleware).
 *
 * @param req.params.id - Document UUID
 * @param req.body.email - Email of user to share with
 * @param req.body.permission_level - Permission level: 'view', 'comment', or 'edit'
 * @returns {ApiResponse<void>} Success message
 */
router.post('/:id/share', authenticate, requireShare, idempotency, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const { email, permission_level } = req.body;

    if (!email || !permission_level) {
      res.status(400).json({ success: false, error: 'Email and permission level required' });
      return;
    }

    if (!['view', 'comment', 'edit'].includes(permission_level)) {
      res.status(400).json({ success: false, error: 'Invalid permission level' });
      return;
    }

    // Find user by email
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      // Store email-based permission for future user
      await pool.query(
        `INSERT INTO document_permissions (document_id, email, permission_level)
         VALUES ($1, $2, $3)
         ON CONFLICT (document_id, email) DO UPDATE SET permission_level = $3`,
        [documentId, email, permission_level]
      );

      logger.info({ userId, documentId, sharedWithEmail: email, permission_level }, 'Document shared with email');
    } else {
      const targetUserId = userResult.rows[0].id;

      await pool.query(
        `INSERT INTO document_permissions (document_id, user_id, permission_level)
         VALUES ($1, $2, $3)
         ON CONFLICT (document_id, user_id) DO UPDATE SET permission_level = $3`,
        [documentId, targetUserId, permission_level]
      );

      logger.info({ userId, documentId, sharedWithUserId: targetUserId, permission_level }, 'Document shared with user');
    }

    res.json({
      success: true,
      message: 'Document shared successfully',
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id, documentId: req.params.id }, 'Share document error');
    res.status(500).json({ success: false, error: 'Failed to share document' });
  }
});

/**
 * GET /api/documents/:id/permissions
 * Lists all permission grants for a document.
 * Only the document owner can view permissions (enforced by RBAC middleware).
 * Includes user names and avatar colors for granted users.
 *
 * @param req.params.id - Document UUID
 * @returns {ApiResponse<{permissions: DocumentPermission[]}>} List of permission records
 */
router.get('/:id/permissions', authenticate, requireShare, async (req: Request, res: Response) => {
  try {
    const documentId = req.params.id;

    const result = await pool.query(
      `SELECT dp.*, u.name, u.avatar_color
       FROM document_permissions dp
       LEFT JOIN users u ON dp.user_id = u.id
       WHERE dp.document_id = $1`,
      [documentId]
    );

    res.json({
      success: true,
      data: { permissions: result.rows },
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id, documentId: req.params.id }, 'Get permissions error');
    res.status(500).json({ success: false, error: 'Failed to get permissions' });
  }
});

/**
 * DELETE /api/documents/:id/permissions/:permissionId
 * Removes a specific permission grant from a document.
 * Only the document owner can modify permissions (enforced by RBAC middleware).
 * Revokes the user's access to the document.
 *
 * @param req.params.id - Document UUID
 * @param req.params.permissionId - Permission record UUID to remove
 * @returns {ApiResponse<void>} Success message
 */
router.delete('/:id/permissions/:permissionId', authenticate, requireShare, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const permissionId = req.params.permissionId;

    await pool.query(
      'DELETE FROM document_permissions WHERE id = $1 AND document_id = $2',
      [permissionId, documentId]
    );

    logger.info({ userId, documentId, permissionId }, 'Permission removed');

    res.json({
      success: true,
      message: 'Permission removed',
    });
  } catch (error) {
    logger.error({ error, userId: req.user?.id, documentId: req.params.id }, 'Remove permission error');
    res.status(500).json({ success: false, error: 'Failed to remove permission' });
  }
});

/** Exports the documents router for mounting in the main application */
export default router;
