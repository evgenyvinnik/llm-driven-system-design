import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pool from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import type { DocumentListItem, DocumentWithPermission, PermissionLevel } from '../types/index.js';

const router = Router();

/**
 * GET /api/documents
 * List all documents accessible to the user
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

    res.json({
      success: true,
      data: { documents },
    });
  } catch (error) {
    console.error('List documents error:', error);
    res.status(500).json({ success: false, error: 'Failed to list documents' });
  }
});

/**
 * POST /api/documents
 * Create a new document
 */
router.post('/', authenticate, async (req: Request, res: Response) => {
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

    res.status(201).json({
      success: true,
      data: { document },
    });
  } catch (error) {
    console.error('Create document error:', error);
    res.status(500).json({ success: false, error: 'Failed to create document' });
  }
});

/**
 * GET /api/documents/:id
 * Get document by ID
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

    res.json({
      success: true,
      data: { document },
    });
  } catch (error) {
    console.error('Get document error:', error);
    res.status(500).json({ success: false, error: 'Failed to get document' });
  }
});

/**
 * PATCH /api/documents/:id
 * Update document title
 */
router.patch('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const { title } = req.body;

    // Check permission
    const permCheck = await pool.query(
      `SELECT d.owner_id, dp.permission_level
       FROM documents d
       LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
       WHERE d.id = $1`,
      [documentId, userId]
    );

    if (permCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    const { owner_id, permission_level } = permCheck.rows[0];

    if (owner_id !== userId && permission_level !== 'edit') {
      res.status(403).json({ success: false, error: 'Edit permission required' });
      return;
    }

    const result = await pool.query(
      `UPDATE documents SET title = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [title, documentId]
    );

    res.json({
      success: true,
      data: { document: result.rows[0] },
    });
  } catch (error) {
    console.error('Update document error:', error);
    res.status(500).json({ success: false, error: 'Failed to update document' });
  }
});

/**
 * DELETE /api/documents/:id
 * Soft delete a document
 */
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;

    // Only owner can delete
    const result = await pool.query(
      `UPDATE documents SET is_deleted = true, updated_at = NOW()
       WHERE id = $1 AND owner_id = $2
       RETURNING id`,
      [documentId, userId]
    );

    if (result.rows.length === 0) {
      res.status(403).json({ success: false, error: 'Only owner can delete document' });
      return;
    }

    res.json({
      success: true,
      message: 'Document deleted',
    });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete document' });
  }
});

/**
 * POST /api/documents/:id/share
 * Share document with another user
 */
router.post('/:id/share', authenticate, async (req: Request, res: Response) => {
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

    // Check if user is owner
    const docCheck = await pool.query(
      'SELECT owner_id FROM documents WHERE id = $1',
      [documentId]
    );

    if (docCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    if (docCheck.rows[0].owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only owner can share document' });
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
    } else {
      const targetUserId = userResult.rows[0].id;

      await pool.query(
        `INSERT INTO document_permissions (document_id, user_id, permission_level)
         VALUES ($1, $2, $3)
         ON CONFLICT (document_id, user_id) DO UPDATE SET permission_level = $3`,
        [documentId, targetUserId, permission_level]
      );
    }

    res.json({
      success: true,
      message: 'Document shared successfully',
    });
  } catch (error) {
    console.error('Share document error:', error);
    res.status(500).json({ success: false, error: 'Failed to share document' });
  }
});

/**
 * GET /api/documents/:id/permissions
 * Get document permissions
 */
router.get('/:id/permissions', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;

    // Check if user is owner
    const docCheck = await pool.query(
      'SELECT owner_id FROM documents WHERE id = $1',
      [documentId]
    );

    if (docCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    if (docCheck.rows[0].owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only owner can view permissions' });
      return;
    }

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
    console.error('Get permissions error:', error);
    res.status(500).json({ success: false, error: 'Failed to get permissions' });
  }
});

/**
 * DELETE /api/documents/:id/permissions/:permissionId
 * Remove a permission
 */
router.delete('/:id/permissions/:permissionId', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const permissionId = req.params.permissionId;

    // Check if user is owner
    const docCheck = await pool.query(
      'SELECT owner_id FROM documents WHERE id = $1',
      [documentId]
    );

    if (docCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    if (docCheck.rows[0].owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only owner can modify permissions' });
      return;
    }

    await pool.query(
      'DELETE FROM document_permissions WHERE id = $1 AND document_id = $2',
      [permissionId, documentId]
    );

    res.json({
      success: true,
      message: 'Permission removed',
    });
  } catch (error) {
    console.error('Remove permission error:', error);
    res.status(500).json({ success: false, error: 'Failed to remove permission' });
  }
});

export default router;
