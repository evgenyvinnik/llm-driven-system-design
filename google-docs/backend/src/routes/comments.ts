import { Router, Request, Response } from 'express';
import pool from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import type { Comment } from '../types/index.js';

const router = Router();

/**
 * GET /api/documents/:id/comments
 * List all comments for a document
 */
router.get('/:id/comments', authenticate, async (req: Request, res: Response) => {
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

    // Get top-level comments with replies
    const result = await pool.query(
      `SELECT c.*,
              u.name as author_name,
              u.email as author_email,
              u.avatar_color as author_avatar_color
       FROM comments c
       JOIN users u ON c.author_id = u.id
       WHERE c.document_id = $1
       ORDER BY c.created_at ASC`,
      [documentId]
    );

    // Organize into threads
    const commentsMap = new Map<string, Comment>();
    const topLevelComments: Comment[] = [];

    for (const row of result.rows) {
      const comment: Comment = {
        id: row.id,
        document_id: row.document_id,
        parent_id: row.parent_id,
        anchor_start: row.anchor_start,
        anchor_end: row.anchor_end,
        anchor_version: row.anchor_version,
        content: row.content,
        author_id: row.author_id,
        resolved: row.resolved,
        created_at: row.created_at,
        updated_at: row.updated_at,
        author: {
          id: row.author_id,
          email: row.author_email,
          name: row.author_name,
          avatar_color: row.author_avatar_color,
          role: 'user',
        },
        replies: [],
      };

      commentsMap.set(comment.id, comment);

      if (!row.parent_id) {
        topLevelComments.push(comment);
      }
    }

    // Attach replies to parents
    for (const row of result.rows) {
      if (row.parent_id) {
        const parent = commentsMap.get(row.parent_id);
        const comment = commentsMap.get(row.id);
        if (parent && comment) {
          parent.replies!.push(comment);
        }
      }
    }

    res.json({
      success: true,
      data: { comments: topLevelComments },
    });
  } catch (error) {
    console.error('List comments error:', error);
    res.status(500).json({ success: false, error: 'Failed to list comments' });
  }
});

/**
 * POST /api/documents/:id/comments
 * Add a comment to a document
 */
router.post('/:id/comments', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const { content, anchor_start, anchor_end, anchor_version, parent_id } = req.body;

    if (!content) {
      res.status(400).json({ success: false, error: 'Comment content is required' });
      return;
    }

    // Check access (at least comment permission)
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
    if (owner_id !== userId && !['comment', 'edit'].includes(permission_level)) {
      res.status(403).json({ success: false, error: 'Comment permission required' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO comments (document_id, parent_id, anchor_start, anchor_end, anchor_version, content, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [documentId, parent_id || null, anchor_start, anchor_end, anchor_version, content, userId]
    );

    const comment = result.rows[0];

    // Get author info
    comment.author = {
      id: req.user!.id,
      email: req.user!.email,
      name: req.user!.name,
      avatar_color: req.user!.avatar_color,
      role: req.user!.role,
    };

    res.status(201).json({
      success: true,
      data: { comment },
    });
  } catch (error) {
    console.error('Create comment error:', error);
    res.status(500).json({ success: false, error: 'Failed to create comment' });
  }
});

/**
 * PATCH /api/documents/:id/comments/:commentId
 * Update a comment
 */
router.patch('/:id/comments/:commentId', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const commentId = req.params.commentId;
    const { content, resolved } = req.body;

    // Check ownership or document owner
    const checkResult = await pool.query(
      `SELECT c.author_id, d.owner_id
       FROM comments c
       JOIN documents d ON c.document_id = d.id
       WHERE c.id = $1 AND c.document_id = $2`,
      [commentId, documentId]
    );

    if (checkResult.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Comment not found' });
      return;
    }

    const { author_id, owner_id } = checkResult.rows[0];

    // Only author can edit content, but owner can resolve
    if (content && author_id !== userId) {
      res.status(403).json({ success: false, error: 'Only author can edit comment' });
      return;
    }

    if (resolved !== undefined && author_id !== userId && owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only author or document owner can resolve' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    if (content) {
      updates.push(`content = $${paramCount++}`);
      values.push(content);
    }

    if (resolved !== undefined) {
      updates.push(`resolved = $${paramCount++}`);
      values.push(resolved);
    }

    if (updates.length === 0) {
      res.status(400).json({ success: false, error: 'No updates provided' });
      return;
    }

    updates.push(`updated_at = NOW()`);
    values.push(commentId);

    const result = await pool.query(
      `UPDATE comments SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    res.json({
      success: true,
      data: { comment: result.rows[0] },
    });
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({ success: false, error: 'Failed to update comment' });
  }
});

/**
 * DELETE /api/documents/:id/comments/:commentId
 * Delete a comment
 */
router.delete('/:id/comments/:commentId', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const documentId = req.params.id;
    const commentId = req.params.commentId;

    // Check ownership
    const checkResult = await pool.query(
      `SELECT c.author_id, d.owner_id
       FROM comments c
       JOIN documents d ON c.document_id = d.id
       WHERE c.id = $1 AND c.document_id = $2`,
      [commentId, documentId]
    );

    if (checkResult.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Comment not found' });
      return;
    }

    const { author_id, owner_id } = checkResult.rows[0];

    if (author_id !== userId && owner_id !== userId) {
      res.status(403).json({ success: false, error: 'Only author or document owner can delete' });
      return;
    }

    // Delete comment and its replies
    await pool.query(
      'DELETE FROM comments WHERE id = $1 OR parent_id = $1',
      [commentId]
    );

    res.json({
      success: true,
      message: 'Comment deleted',
    });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete comment' });
  }
});

export default router;
