import { Router, Request, Response } from 'express';
import pool from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/documents/:id/versions
 * List all versions of a document
 */
router.get('/:id/versions', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;

    // Check access
    const accessCheck = await pool.query(
      `SELECT d.owner_id, dp.permission_level
       FROM documents d
       LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
       WHERE d.id = $1`,
      [documentId, userId]
    );

    if (accessCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    const { owner_id, permission_level } = accessCheck.rows[0];
    if (owner_id !== userId && !permission_level) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const result = await pool.query(
      `SELECT dv.id, dv.version_number, dv.is_named, dv.name, dv.created_at,
              u.name as created_by_name, u.avatar_color
       FROM document_versions dv
       LEFT JOIN users u ON dv.created_by = u.id
       WHERE dv.document_id = $1
       ORDER BY dv.version_number DESC
       LIMIT 100`,
      [documentId]
    );

    res.json({
      success: true,
      data: { versions: result.rows },
    });
  } catch (error) {
    console.error('List versions error:', error);
    res.status(500).json({ success: false, error: 'Failed to list versions' });
  }
});

/**
 * GET /api/documents/:id/versions/:versionNumber
 * Get a specific version of a document
 */
router.get('/:id/versions/:versionNumber', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const versionNumber = parseInt(req.params.versionNumber);

    // Check access
    const accessCheck = await pool.query(
      `SELECT d.owner_id, dp.permission_level
       FROM documents d
       LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
       WHERE d.id = $1`,
      [documentId, userId]
    );

    if (accessCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    const { owner_id, permission_level } = accessCheck.rows[0];
    if (owner_id !== userId && !permission_level) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const result = await pool.query(
      `SELECT dv.*, u.name as created_by_name, u.avatar_color
       FROM document_versions dv
       LEFT JOIN users u ON dv.created_by = u.id
       WHERE dv.document_id = $1 AND dv.version_number = $2`,
      [documentId, versionNumber]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Version not found' });
      return;
    }

    res.json({
      success: true,
      data: { version: result.rows[0] },
    });
  } catch (error) {
    console.error('Get version error:', error);
    res.status(500).json({ success: false, error: 'Failed to get version' });
  }
});

/**
 * POST /api/documents/:id/versions
 * Create a named version
 */
router.post('/:id/versions', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const { name } = req.body;

    // Check edit access
    const accessCheck = await pool.query(
      `SELECT d.owner_id, d.current_version, d.content, dp.permission_level
       FROM documents d
       LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
       WHERE d.id = $1`,
      [documentId, userId]
    );

    if (accessCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    const { owner_id, current_version, content, permission_level } = accessCheck.rows[0];
    if (owner_id !== userId && permission_level !== 'edit') {
      res.status(403).json({ success: false, error: 'Edit permission required' });
      return;
    }

    // Create named version at current version
    const result = await pool.query(
      `INSERT INTO document_versions (document_id, version_number, content, created_by, is_named, name)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (document_id, version_number)
       DO UPDATE SET is_named = true, name = $5
       RETURNING *`,
      [documentId, current_version, content, userId, name || `Version ${current_version}`]
    );

    res.status(201).json({
      success: true,
      data: { version: result.rows[0] },
    });
  } catch (error) {
    console.error('Create version error:', error);
    res.status(500).json({ success: false, error: 'Failed to create version' });
  }
});

/**
 * POST /api/documents/:id/versions/:versionNumber/restore
 * Restore a document to a specific version
 */
router.post('/:id/versions/:versionNumber/restore', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const versionNumber = parseInt(req.params.versionNumber);

    // Check edit access
    const accessCheck = await pool.query(
      `SELECT d.owner_id, d.current_version, dp.permission_level
       FROM documents d
       LEFT JOIN document_permissions dp ON d.id = dp.document_id AND dp.user_id = $2
       WHERE d.id = $1`,
      [documentId, userId]
    );

    if (accessCheck.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Document not found' });
      return;
    }

    const { owner_id, current_version, permission_level } = accessCheck.rows[0];
    if (owner_id !== userId && permission_level !== 'edit') {
      res.status(403).json({ success: false, error: 'Edit permission required' });
      return;
    }

    // Get version content
    const versionResult = await pool.query(
      'SELECT content FROM document_versions WHERE document_id = $1 AND version_number = $2',
      [documentId, versionNumber]
    );

    if (versionResult.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Version not found' });
      return;
    }

    const newVersion = current_version + 1;

    // Update document with restored content
    await pool.query(
      `UPDATE documents
       SET content = $1, current_version = $2, updated_at = NOW()
       WHERE id = $3`,
      [versionResult.rows[0].content, newVersion, documentId]
    );

    // Create new version entry
    await pool.query(
      `INSERT INTO document_versions (document_id, version_number, content, created_by, is_named, name)
       VALUES ($1, $2, $3, $4, true, $5)`,
      [documentId, newVersion, versionResult.rows[0].content, userId, `Restored from version ${versionNumber}`]
    );

    res.json({
      success: true,
      message: 'Document restored',
      data: { new_version: newVersion },
    });
  } catch (error) {
    console.error('Restore version error:', error);
    res.status(500).json({ success: false, error: 'Failed to restore version' });
  }
});

export default router;
