import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../services/db.js';
import { logger } from '../services/logger.js';
import { AccessError, callerFrom, isUuid, requirePage, respondError } from '../services/accessService.js';

/** Loads a comment's page ID, or throws 404. */
async function commentPage(commentId: string): Promise<{ page_id: string; user_id: string }> {
  if (!isUuid(commentId)) throw new AccessError(404, 'Comment not found');
  const found = await pool.query('SELECT page_id, user_id FROM page_comments WHERE id = $1', [commentId]);
  if (!found.rows[0]) throw new AccessError(404, 'Comment not found');
  return found.rows[0];
}

const router = Router();

// Get comments for a page
router.get('/page/:pageId', async (req: Request, res: Response) => {
  try {
    await requirePage(req.params.pageId, callerFrom(req), 'view');
    const result = await pool.query(
      `SELECT pc.*, u.username, u.display_name, u.avatar_url
       FROM page_comments pc
       JOIN users u ON u.id = pc.user_id
       WHERE pc.page_id = $1
       ORDER BY pc.created_at ASC`,
      [req.params.pageId],
    );

    // Build threaded structure
    const comments = result.rows;
    const topLevel = comments.filter((c: { parent_id: string | null }) => !c.parent_id);
    const replies = comments.filter((c: { parent_id: string | null }) => c.parent_id);

    const threaded = topLevel.map((comment: { id: string }) => ({
      ...comment,
      replies: replies.filter((r: { parent_id: string }) => r.parent_id === comment.id),
    }));

    res.json({ comments: threaded });
  } catch (err) {
    respondError(res, err, 'Failed to get comments');
  }
});

// Add comment
router.post('/page/:pageId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { content, parentId } = req.body;

    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    // Anyone who can read the page may comment, including viewers.
    await requirePage(req.params.pageId, callerFrom(req), 'view');

    // Threads are one level deep: a reply to a reply joins the root's thread,
    // and a parent must be a comment on this same page.
    let rootId: string | null = null;
    if (parentId) {
      const parent = isUuid(parentId)
        ? await pool.query('SELECT page_id, parent_id FROM page_comments WHERE id = $1', [parentId])
        : { rows: [] };
      if (parent.rows[0]?.page_id !== req.params.pageId) {
        throw new AccessError(400, 'Reply must be to a comment on the same page');
      }
      rootId = parent.rows[0].parent_id ?? parentId;
    }

    const result = await pool.query(
      `INSERT INTO page_comments (page_id, user_id, parent_id, content)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.pageId, req.session.userId, rootId, content],
    );

    // Fetch with user info
    const comment = await pool.query(
      `SELECT pc.*, u.username, u.display_name, u.avatar_url
       FROM page_comments pc
       JOIN users u ON u.id = pc.user_id
       WHERE pc.id = $1`,
      [result.rows[0].id],
    );

    logger.info({ commentId: result.rows[0].id, pageId: req.params.pageId }, 'Comment added');
    res.status(201).json({ comment: comment.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to add comment');
  }
});

// Update comment
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { content } = req.body;

    const result = await pool.query(
      `UPDATE page_comments SET content = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [content, req.params.id, req.session.userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found or not authorized' });
      return;
    }

    res.json({ comment: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to update comment');
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

// Delete comment
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      'DELETE FROM page_comments WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.session.userId],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found or not authorized' });
      return;
    }

    res.json({ message: 'Comment deleted' });
  } catch (err) {
    logger.error({ err }, 'Failed to delete comment');
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// Resolve/unresolve comment
router.post('/:id/resolve', requireAuth, async (req: Request, res: Response) => {
  try {
    // The comment's author or an editor of the space may resolve it; this used
    // to be open to any signed-in user, for any comment in any space.
    const comment = await commentPage(req.params.id);
    const { access } = await requirePage(comment.page_id, callerFrom(req), 'view');
    if (comment.user_id !== req.session.userId && !access.canEdit) {
      throw new AccessError(403, 'Only the author or a space member can resolve this comment');
    }
    const result = await pool.query(
      `UPDATE page_comments SET is_resolved = NOT is_resolved, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id],
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }

    res.json({ comment: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to resolve comment');
  }
});

/** Router for threaded page comments with CRUD and resolve/unresolve toggle. */
export default router;
