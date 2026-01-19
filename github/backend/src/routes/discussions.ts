import { Router } from 'express';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * Get next discussion number for a repo
 */
async function getNextNumber(repoId) {
  const result = await query(
    'SELECT COALESCE(MAX(number), 0) as max_num FROM discussions WHERE repo_id = $1',
    [repoId]
  );
  return parseInt(result.rows[0].max_num) + 1;
}

/**
 * List discussions for a repo
 */
router.get('/:owner/:repo/discussions', async (req, res) => {
  const { owner, repo } = req.params;
  const { category, page = 1, limit = 20 } = req.query;

  const repoResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoResult.rows[0].id;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [repoId];

  let whereClause = 'WHERE d.repo_id = $1';

  if (category) {
    params.push(category);
    whereClause += ` AND d.category = $${params.length}`;
  }

  const result = await query(
    `SELECT d.*,
            author.username as author_name,
            author.avatar_url as author_avatar,
            (SELECT COUNT(*) FROM discussion_comments WHERE discussion_id = d.id) as comments_count
     FROM discussions d
     JOIN users author ON d.author_id = author.id
     ${whereClause}
     ORDER BY d.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );

  const countResult = await query(
    `SELECT COUNT(*) FROM discussions d ${whereClause}`,
    params
  );

  res.json({
    discussions: result.rows,
    total: parseInt(countResult.rows[0].count),
    page: parseInt(page),
    limit: parseInt(limit),
  });
});

/**
 * Get single discussion
 */
router.get('/:owner/:repo/discussions/:number', async (req, res) => {
  const { owner, repo, number } = req.params;

  const result = await query(
    `SELECT d.*,
            author.username as author_name,
            author.avatar_url as author_avatar,
            author.display_name as author_display_name
     FROM discussions d
     JOIN repositories r ON d.repo_id = r.id
     JOIN users owner_user ON r.owner_id = owner_user.id
     JOIN users author ON d.author_id = author.id
     WHERE owner_user.username = $1 AND r.name = $2 AND d.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Discussion not found' });
  }

  const discussion = result.rows[0];

  // Get comments with nested replies
  const comments = await query(
    `SELECT c.*,
            u.username as user_name,
            u.avatar_url as user_avatar
     FROM discussion_comments c
     JOIN users u ON c.user_id = u.id
     WHERE c.discussion_id = $1 AND c.parent_id IS NULL
     ORDER BY c.created_at ASC`,
    [discussion.id]
  );

  // Get replies for each comment
  for (const comment of comments.rows) {
    const replies = await query(
      `SELECT c.*,
              u.username as user_name,
              u.avatar_url as user_avatar
       FROM discussion_comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.parent_id = $1
       ORDER BY c.created_at ASC`,
      [comment.id]
    );
    comment.replies = replies.rows;
  }

  res.json({
    ...discussion,
    comments: comments.rows,
  });
});

/**
 * Create discussion
 */
router.post('/:owner/:repo/discussions', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;
  const { title, body, category } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body required' });
  }

  const repoResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const repoId = repoResult.rows[0].id;
  const number = await getNextNumber(repoId);

  const result = await query(
    `INSERT INTO discussions (repo_id, number, title, body, category, author_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [repoId, number, title, body, category || 'general', req.user.id]
  );

  res.status(201).json(result.rows[0]);
});

/**
 * Add comment to discussion
 */
router.post('/:owner/:repo/discussions/:number/comments', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { body, parentId } = req.body;

  if (!body) {
    return res.status(400).json({ error: 'Comment body required' });
  }

  const discussionResult = await query(
    `SELECT d.id FROM discussions d
     JOIN repositories r ON d.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND d.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (discussionResult.rows.length === 0) {
    return res.status(404).json({ error: 'Discussion not found' });
  }

  const result = await query(
    `INSERT INTO discussion_comments (discussion_id, user_id, parent_id, body)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [discussionResult.rows[0].id, req.user.id, parentId || null, body]
  );

  res.status(201).json(result.rows[0]);
});

/**
 * Mark answer
 */
router.post('/:owner/:repo/discussions/:number/answer', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { commentId } = req.body;

  const discussionResult = await query(
    `SELECT d.*, r.owner_id FROM discussions d
     JOIN repositories r ON d.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND d.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (discussionResult.rows.length === 0) {
    return res.status(404).json({ error: 'Discussion not found' });
  }

  const discussion = discussionResult.rows[0];

  // Only author or repo owner can mark answer
  if (discussion.author_id !== req.user.id && discussion.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await query(
    'UPDATE discussions SET is_answered = TRUE, answer_comment_id = $1, updated_at = NOW() WHERE id = $2',
    [commentId, discussion.id]
  );

  res.json({ success: true });
});

/**
 * Upvote comment
 */
router.post('/:owner/:repo/discussions/:number/comments/:commentId/upvote', requireAuth, async (req, res) => {
  const { commentId } = req.params;

  await query(
    'UPDATE discussion_comments SET upvotes = upvotes + 1 WHERE id = $1',
    [parseInt(commentId)]
  );

  res.json({ success: true });
});

export default router;
