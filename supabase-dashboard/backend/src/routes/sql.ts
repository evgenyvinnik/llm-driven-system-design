import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { executeUserSql } from '../services/queryExecutor.js';
import { queryLimiter } from '../services/rateLimiter.js';
import { queryExecutionDuration } from '../services/metrics.js';
import { ApiError, respondError } from '../services/errors.js';
import { isUuid, requireProject } from '../services/projectAccess.js';

const router = Router();

// The first keyword is user input; bucketing it keeps the metric's label set bounded.
const QUERY_TYPES = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'EXPLAIN', 'DO']);

function queryType(sql: string): string {
  const first = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  return QUERY_TYPES.has(first) ? first : 'OTHER';
}

function savedQueryDto(r: Record<string, unknown>) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    queryText: r.query_text,
    createdBy: r.created_by,
    createdByUsername: r.created_by_username,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseSavedQuery(body: unknown, partial: boolean): { name?: string; queryText?: string } {
  const { name, queryText } = (body ?? {}) as Record<string, unknown>;
  if (!partial && (!name || !queryText)) throw new ApiError(400, 'name and queryText are required');
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '' || name.length > 100)) {
    throw new ApiError(400, 'name must be 1-100 characters');
  }
  if (queryText !== undefined && (typeof queryText !== 'string' || queryText.trim() === '')) {
    throw new ApiError(400, 'queryText must be a non-empty string');
  }
  return { name: name?.trim(), queryText };
}

// POST /api/projects/:projectId/sql/execute — viewers run read-only
router.post('/:projectId/sql/execute', requireAuth, queryLimiter, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const { sql } = req.body ?? {};

    if (!sql || typeof sql !== 'string') {
      throw new ApiError(400, 'SQL query string is required');
    }
    if (sql.trim().length === 0) {
      throw new ApiError(400, 'SQL query cannot be empty');
    }

    const timer = queryExecutionDuration.startTimer({ project_id: access.projectId, query_type: queryType(sql) });
    try {
      const result = await executeUserSql(access.projectId, access.connection(), sql, { readOnly: !access.canEdit });
      res.json({ ...result, readOnly: !access.canEdit });
    } finally {
      timer();
    }
  } catch (err) {
    respondError(res, err, 'SQL execution error');
  }
});

// GET /api/projects/:projectId/sql/saved
router.get('/:projectId/sql/saved', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const result = await pool.query(
      `SELECT sq.*, u.username AS created_by_username
       FROM saved_queries sq
       LEFT JOIN users u ON u.id = sq.created_by
       WHERE sq.project_id = $1
       ORDER BY sq.updated_at DESC`,
      [access.projectId],
    );
    res.json({ queries: result.rows.map(savedQueryDto) });
  } catch (err) {
    respondError(res, err, 'Failed to list saved queries');
  }
});

// POST /api/projects/:projectId/sql/saved
router.post('/:projectId/sql/saved', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const { name, queryText } = parseSavedQuery(req.body, false);
    const result = await pool.query(
      `INSERT INTO saved_queries (project_id, name, query_text, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [access.projectId, name, queryText, req.session.userId],
    );
    res.status(201).json({ query: savedQueryDto({ ...result.rows[0], created_by_username: req.session.username }) });
  } catch (err) {
    respondError(res, err, 'Failed to save query');
  }
});

// PUT /api/projects/:projectId/sql/saved/:queryId
router.put('/:projectId/sql/saved/:queryId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    if (!isUuid(req.params.queryId)) throw new ApiError(404, 'Saved query not found');
    const { name, queryText } = parseSavedQuery(req.body, true);

    const result = await pool.query(
      `UPDATE saved_queries
       SET name = COALESCE($1, name),
           query_text = COALESCE($2, query_text),
           updated_at = NOW()
       WHERE id = $3 AND project_id = $4
       RETURNING *`,
      [name ?? null, queryText ?? null, req.params.queryId, access.projectId],
    );
    if (result.rows.length === 0) throw new ApiError(404, 'Saved query not found');
    res.json({ query: savedQueryDto(result.rows[0]) });
  } catch (err) {
    respondError(res, err, 'Failed to update saved query');
  }
});

// DELETE /api/projects/:projectId/sql/saved/:queryId
router.delete('/:projectId/sql/saved/:queryId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    if (!isUuid(req.params.queryId)) throw new ApiError(404, 'Saved query not found');
    const result = await pool.query('DELETE FROM saved_queries WHERE id = $1 AND project_id = $2', [
      req.params.queryId,
      access.projectId,
    ]);
    if ((result.rowCount ?? 0) === 0) throw new ApiError(404, 'Saved query not found');
    res.json({ message: 'Saved query deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete saved query');
  }
});

/** SQL router for executing arbitrary queries and managing saved queries per project. */
export default router;
