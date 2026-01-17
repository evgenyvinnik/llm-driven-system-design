import { Router, Request, Response } from 'express';
import pool from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/documents/:id/suggestions
 * List all suggestions for a document
 */
router.get('/:id/suggestions', authenticate, async (req: Request, res: Response) => {
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
      `SELECT s.*,
              u.name as author_name,
              u.email as author_email,
              u.avatar_color as author_avatar_color
       FROM suggestions s
       JOIN users u ON s.author_id = u.id
       WHERE s.document_id = $1
       ORDER BY s.created_at DESC`,
      [documentId]
    );

    const suggestions = result.rows.map(row => ({
      ...row,
      author: {
        id: row.author_id,
        email: row.author_email,
        name: row.author_name,
        avatar_color: row.author_avatar_color,
        role: 'user',
      },
    }));

    res.json({
      success: true,
      data: { suggestions },
    });
  } catch (error) {
    console.error('List suggestions error:', error);
    res.status(500).json({ success: false, error: 'Failed to list suggestions' });
  }
});

/**
 * POST /api/documents/:id/suggestions
 * Create a suggestion
 */
router.post('/:id/suggestions', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const { suggestion_type, anchor_start, anchor_end, anchor_version, original_text, suggested_text } = req.body;

    if (!suggestion_type || anchor_start === undefined || anchor_end === undefined) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }

    // Check edit access
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
    if (owner_id !== userId && permission_level !== 'edit') {
      res.status(403).json({ success: false, error: 'Edit permission required' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO suggestions (document_id, suggestion_type, anchor_start, anchor_end, anchor_version, original_text, suggested_text, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [documentId, suggestion_type, anchor_start, anchor_end, anchor_version, original_text, suggested_text, userId]
    );

    const suggestion = result.rows[0];
    suggestion.author = {
      id: req.user!.id,
      email: req.user!.email,
      name: req.user!.name,
      avatar_color: req.user!.avatar_color,
      role: req.user!.role,
    };

    res.status(201).json({
      success: true,
      data: { suggestion },
    });
  } catch (error) {
    console.error('Create suggestion error:', error);
    res.status(500).json({ success: false, error: 'Failed to create suggestion' });
  }
});

/**
 * POST /api/documents/:id/suggestions/:suggestionId/accept
 * Accept a suggestion
 */
router.post('/:id/suggestions/:suggestionId/accept', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const suggestionId = req.params.suggestionId;

    // Check edit access
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
    if (owner_id !== userId && permission_level !== 'edit') {
      res.status(403).json({ success: false, error: 'Edit permission required' });
      return;
    }

    // Update suggestion status
    const result = await pool.query(
      `UPDATE suggestions SET status = 'accepted', updated_at = NOW()
       WHERE id = $1 AND document_id = $2
       RETURNING *`,
      [suggestionId, documentId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Suggestion not found' });
      return;
    }

    // Note: In a real implementation, we would apply the suggestion to the document here
    // This would involve creating an operation and broadcasting it via WebSocket

    res.json({
      success: true,
      data: { suggestion: result.rows[0] },
      message: 'Suggestion accepted',
    });
  } catch (error) {
    console.error('Accept suggestion error:', error);
    res.status(500).json({ success: false, error: 'Failed to accept suggestion' });
  }
});

/**
 * POST /api/documents/:id/suggestions/:suggestionId/reject
 * Reject a suggestion
 */
router.post('/:id/suggestions/:suggestionId/reject', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const suggestionId = req.params.suggestionId;

    // Check edit access
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
    if (owner_id !== userId && permission_level !== 'edit') {
      res.status(403).json({ success: false, error: 'Edit permission required' });
      return;
    }

    const result = await pool.query(
      `UPDATE suggestions SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND document_id = $2
       RETURNING *`,
      [suggestionId, documentId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Suggestion not found' });
      return;
    }

    res.json({
      success: true,
      data: { suggestion: result.rows[0] },
      message: 'Suggestion rejected',
    });
  } catch (error) {
    console.error('Reject suggestion error:', error);
    res.status(500).json({ success: false, error: 'Failed to reject suggestion' });
  }
});

/**
 * DELETE /api/documents/:id/suggestions/:suggestionId
 * Delete a suggestion
 */
router.delete('/:id/suggestions/:suggestionId', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const suggestionId = req.params.suggestionId;

    // Check ownership
    const checkResult = await pool.query(
      `SELECT s.author_id, d.owner_id
       FROM suggestions s
       JOIN documents d ON s.document_id = d.id
       WHERE s.id = $1 AND s.document_id = $2`,
      [suggestionId, documentId]
    );

    if (checkResult.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Suggestion not found' });
      return;
    }

    const { author_id, owner_id } = checkResult.rows[0];

    if (author_id !== userId && owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only author or document owner can delete' });
      return;
    }

    await pool.query('DELETE FROM suggestions WHERE id = $1', [suggestionId]);

    res.json({
      success: true,
      message: 'Suggestion deleted',
    });
  } catch (error) {
    console.error('Delete suggestion error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete suggestion' });
  }
});

export default router;
