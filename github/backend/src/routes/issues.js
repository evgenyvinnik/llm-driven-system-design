import { Router } from 'express';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * Get next issue number for a repo
 */
async function getNextNumber(repoId) {
  const prResult = await query(
    'SELECT COALESCE(MAX(number), 0) as max_num FROM pull_requests WHERE repo_id = $1',
    [repoId]
  );
  const issueResult = await query(
    'SELECT COALESCE(MAX(number), 0) as max_num FROM issues WHERE repo_id = $1',
    [repoId]
  );

  return Math.max(parseInt(prResult.rows[0].max_num), parseInt(issueResult.rows[0].max_num)) + 1;
}

/**
 * List issues for a repo
 */
router.get('/:owner/:repo/issues', async (req, res) => {
  const { owner, repo } = req.params;
  const { state = 'open', label, assignee, page = 1, limit = 20 } = req.query;

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

  let whereClause = 'WHERE i.repo_id = $1';

  if (state !== 'all') {
    params.push(state);
    whereClause += ` AND i.state = $${params.length}`;
  }

  if (assignee) {
    params.push(assignee);
    whereClause += ` AND assignee.username = $${params.length}`;
  }

  let joinClause = '';
  if (label) {
    params.push(label);
    joinClause = `
      JOIN issue_labels il ON i.id = il.issue_id
      JOIN labels l ON il.label_id = l.id AND l.name = $${params.length}
    `;
  }

  const result = await query(
    `SELECT DISTINCT i.*,
            author.username as author_name,
            author.avatar_url as author_avatar,
            assignee.username as assignee_name
     FROM issues i
     JOIN users author ON i.author_id = author.id
     LEFT JOIN users assignee ON i.assignee_id = assignee.id
     ${joinClause}
     ${whereClause}
     ORDER BY i.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, parseInt(limit), offset]
  );

  // Get labels for each issue
  for (const issue of result.rows) {
    const labels = await query(
      `SELECT l.* FROM labels l
       JOIN issue_labels il ON l.id = il.label_id
       WHERE il.issue_id = $1`,
      [issue.id]
    );
    issue.labels = labels.rows;
  }

  const countResult = await query(
    `SELECT COUNT(DISTINCT i.id) FROM issues i
     LEFT JOIN users assignee ON i.assignee_id = assignee.id
     ${joinClause}
     ${whereClause}`,
    params
  );

  res.json({
    issues: result.rows,
    total: parseInt(countResult.rows[0].count),
    page: parseInt(page),
    limit: parseInt(limit),
  });
});

/**
 * Get single issue
 */
router.get('/:owner/:repo/issues/:number', async (req, res) => {
  const { owner, repo, number } = req.params;

  const result = await query(
    `SELECT i.*,
            author.username as author_name,
            author.avatar_url as author_avatar,
            author.display_name as author_display_name,
            assignee.username as assignee_name,
            assignee.avatar_url as assignee_avatar
     FROM issues i
     JOIN repositories r ON i.repo_id = r.id
     JOIN users owner_user ON r.owner_id = owner_user.id
     JOIN users author ON i.author_id = author.id
     LEFT JOIN users assignee ON i.assignee_id = assignee.id
     WHERE owner_user.username = $1 AND r.name = $2 AND i.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Issue not found' });
  }

  const issue = result.rows[0];

  // Get labels
  const labels = await query(
    `SELECT l.* FROM labels l
     JOIN issue_labels il ON l.id = il.label_id
     WHERE il.issue_id = $1`,
    [issue.id]
  );

  // Get comments
  const comments = await query(
    `SELECT c.*, u.username as user_name, u.avatar_url as user_avatar
     FROM comments c
     JOIN users u ON c.user_id = u.id
     WHERE c.issue_id = $1
     ORDER BY c.created_at ASC`,
    [issue.id]
  );

  res.json({
    ...issue,
    labels: labels.rows,
    comments: comments.rows,
  });
});

/**
 * Create issue
 */
router.post('/:owner/:repo/issues', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;
  const { title, body, labels, assignee } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title required' });
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

  // Get assignee ID if provided
  let assigneeId = null;
  if (assignee) {
    const assigneeResult = await query('SELECT id FROM users WHERE username = $1', [assignee]);
    if (assigneeResult.rows.length > 0) {
      assigneeId = assigneeResult.rows[0].id;
    }
  }

  // Get next number
  const number = await getNextNumber(repoId);

  const result = await query(
    `INSERT INTO issues (repo_id, number, title, body, author_id, assignee_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [repoId, number, title, body || null, req.user.id, assigneeId]
  );

  const issue = result.rows[0];

  // Add labels
  if (labels && labels.length > 0) {
    for (const labelName of labels) {
      const labelResult = await query(
        'SELECT id FROM labels WHERE repo_id = $1 AND name = $2',
        [repoId, labelName]
      );
      if (labelResult.rows.length > 0) {
        await query(
          'INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [issue.id, labelResult.rows[0].id]
        );
      }
    }
  }

  res.status(201).json(issue);
});

/**
 * Update issue
 */
router.patch('/:owner/:repo/issues/:number', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { title, body, state, assignee, labels } = req.body;

  const issueResult = await query(
    `SELECT i.*, r.id as repo_id FROM issues i
     JOIN repositories r ON i.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND i.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (issueResult.rows.length === 0) {
    return res.status(404).json({ error: 'Issue not found' });
  }

  const issue = issueResult.rows[0];

  const updates = [];
  const params = [];

  if (title !== undefined) {
    params.push(title);
    updates.push(`title = $${params.length}`);
  }
  if (body !== undefined) {
    params.push(body);
    updates.push(`body = $${params.length}`);
  }
  if (state !== undefined) {
    params.push(state);
    updates.push(`state = $${params.length}`);
    if (state === 'closed') {
      params.push(new Date());
      updates.push(`closed_at = $${params.length}`);
    }
  }
  if (assignee !== undefined) {
    if (assignee === null) {
      params.push(null);
    } else {
      const assigneeResult = await query('SELECT id FROM users WHERE username = $1', [assignee]);
      params.push(assigneeResult.rows.length > 0 ? assigneeResult.rows[0].id : null);
    }
    updates.push(`assignee_id = $${params.length}`);
  }

  if (updates.length > 0) {
    params.push(new Date());
    updates.push(`updated_at = $${params.length}`);

    params.push(issue.id);

    await query(`UPDATE issues SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
  }

  // Update labels
  if (labels !== undefined) {
    // Remove existing labels
    await query('DELETE FROM issue_labels WHERE issue_id = $1', [issue.id]);

    // Add new labels
    for (const labelName of labels) {
      const labelResult = await query(
        'SELECT id FROM labels WHERE repo_id = $1 AND name = $2',
        [issue.repo_id, labelName]
      );
      if (labelResult.rows.length > 0) {
        await query(
          'INSERT INTO issue_labels (issue_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [issue.id, labelResult.rows[0].id]
        );
      }
    }
  }

  // Return updated issue
  const result = await query('SELECT * FROM issues WHERE id = $1', [issue.id]);
  res.json(result.rows[0]);
});

/**
 * Add comment to issue
 */
router.post('/:owner/:repo/issues/:number/comments', requireAuth, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { body } = req.body;

  if (!body) {
    return res.status(400).json({ error: 'Comment body required' });
  }

  const issueResult = await query(
    `SELECT i.id FROM issues i
     JOIN repositories r ON i.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2 AND i.number = $3`,
    [owner, repo, parseInt(number)]
  );

  if (issueResult.rows.length === 0) {
    return res.status(404).json({ error: 'Issue not found' });
  }

  const result = await query(
    `INSERT INTO comments (issue_id, user_id, body)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [issueResult.rows[0].id, req.user.id, body]
  );

  res.status(201).json(result.rows[0]);
});

/**
 * Get labels for a repo
 */
router.get('/:owner/:repo/labels', async (req, res) => {
  const { owner, repo } = req.params;

  const repoResult = await query(
    `SELECT r.id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const result = await query('SELECT * FROM labels WHERE repo_id = $1 ORDER BY name', [
    repoResult.rows[0].id,
  ]);

  res.json(result.rows);
});

/**
 * Create label
 */
router.post('/:owner/:repo/labels', requireAuth, async (req, res) => {
  const { owner, repo } = req.params;
  const { name, color, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Label name required' });
  }

  const repoResult = await query(
    `SELECT r.id, r.owner_id FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE u.username = $1 AND r.name = $2`,
    [owner, repo]
  );

  if (repoResult.rows.length === 0) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  if (repoResult.rows[0].owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const result = await query(
    `INSERT INTO labels (repo_id, name, color, description)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [repoResult.rows[0].id, name, color || '#1a73e8', description || null]
  );

  res.status(201).json(result.rows[0]);
});

export default router;
