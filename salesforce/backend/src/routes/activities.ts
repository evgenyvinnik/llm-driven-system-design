import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  callerFrom,
  canAccess,
  canSeeRecord,
  isEntityType,
  isUuid,
  ownerScope,
  requireRecord,
  requireReference,
  respondError,
  whereClause,
  ENTITY_TYPES,
  HttpError,
  type Caller,
} from '../services/accessPolicy.js';
import { optionalTimestamp, parsePagination, queryString } from '../services/queryParams.js';

const router = Router();

const VALID_TYPES = ['call', 'email', 'meeting', 'note'];

/**
 * Validates a (relatedType, relatedId) pair from a request body: both or
 * neither, a known type, and a record the caller can see. Without the
 * visibility check, any rep could pin activities to, and so learn the
 * existence of, another rep's records.
 */
async function checkRelated(relatedType: unknown, relatedId: unknown, caller: Caller): Promise<void> {
  const hasType = relatedType !== undefined && relatedType !== null && relatedType !== '';
  const hasId = relatedId !== undefined && relatedId !== null && relatedId !== '';
  if (!hasType && !hasId) return;
  if (!hasType || !hasId) {
    throw new HttpError(400, 'relatedType and relatedId must be given together');
  }
  if (!isEntityType(relatedType)) {
    throw new HttpError(400, `Invalid related type. Must be one of: ${ENTITY_TYPES.join(', ')}`);
  }
  await requireReference(relatedType, relatedId, caller);
}

// GET /api/activities
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const { page, limit, offset } = parsePagination(req.query, 20);
    const relatedType = queryString(req.query.relatedType);
    const relatedId = queryString(req.query.relatedId);
    const completed = queryString(req.query.completed);
    const params: unknown[] = [];
    const conditions: (string | null)[] = [];

    if (relatedType || relatedId) {
      if (!isEntityType(relatedType)) {
        throw new HttpError(400, `Invalid related type. Must be one of: ${ENTITY_TYPES.join(', ')}`);
      }
      // A timeline is controlled by its parent: if the caller can see the
      // record, they see every activity on it, whoever logged it.
      const parent = await requireRecord(relatedType, relatedId, caller);
      params.push(relatedType, parent.id);
      conditions.push('a.related_type = $1', 'a.related_id = $2');
    } else {
      // Without a parent, the list is the caller's own activities.
      conditions.push(ownerScope(caller, 'a', params));
    }

    if (completed !== undefined) {
      params.push(completed === 'true');
      conditions.push(`a.completed = $${params.length}`);
    }

    const where = whereClause(conditions);
    const countParams = [...params];
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT a.*, u.display_name as owner_name
       FROM activities a
       LEFT JOIN users u ON a.owner_id = u.id
       ${where}
       ORDER BY a.due_date ASC NULLS LAST, a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const countResult = await pool.query(`SELECT COUNT(*) FROM activities a ${where}`, countParams);

    res.json({
      activities: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    respondError(res, err, 'Failed to fetch activities');
  }
});

// GET /api/activities/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Activity not found');
    const caller = callerFrom(req);
    const result = await pool.query(
      `SELECT a.*, u.display_name as owner_name
       FROM activities a
       LEFT JOIN users u ON a.owner_id = u.id
       WHERE a.id = $1`,
      [req.params.id],
    );
    const activity = result.rows[0];

    const visible =
      activity &&
      (canAccess(activity, caller) ||
        (await canSeeRecord(activity.related_type, activity.related_id, caller)));
    if (!visible) {
      res.status(404).json({ error: 'Activity not found' });
      return;
    }

    res.json({ activity });
  } catch (err) {
    respondError(res, err, 'Failed to fetch activity');
  }
});

// POST /api/activities
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { type, subject, description, relatedType, relatedId } = req.body;

    if (!type || !subject) {
      res.status(400).json({ error: 'Type and subject are required' });
      return;
    }

    if (!VALID_TYPES.includes(type)) {
      res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }

    const dueDate = optionalTimestamp(req.body.dueDate, 'dueDate');
    await checkRelated(relatedType, relatedId, callerFrom(req));

    const result = await pool.query(
      `INSERT INTO activities (type, subject, description, due_date, related_type, related_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [type, subject, description, dueDate, relatedType || null, relatedId || null, req.session.userId],
    );

    res.status(201).json({ activity: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to create activity');
  }
});

// PUT /api/activities/:id
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Activity not found');
    const caller = callerFrom(req);
    const { type, subject, description, completed, relatedType, relatedId } = req.body;

    if (type && !VALID_TYPES.includes(type)) {
      res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TYPES.join(', ')}` });
      return;
    }
    if (completed !== undefined && typeof completed !== 'boolean') {
      throw new HttpError(400, 'completed must be a boolean');
    }
    const dueDate = optionalTimestamp(req.body.dueDate, 'dueDate');
    // Re-pointing an activity is held to the same rule as creating one.
    await checkRelated(relatedType, relatedId, caller);

    const params: unknown[] = [type, subject, description, dueDate, completed, relatedType || null, relatedId || null, req.params.id];
    // Only the author (or an admin) edits an activity, even though anyone who
    // can see its parent can read it.
    const scope = ownerScope(caller, 'activities', params);

    const result = await pool.query(
      `UPDATE activities
       SET type = COALESCE($1, type),
           subject = COALESCE($2, subject),
           description = COALESCE($3, description),
           due_date = COALESCE($4, due_date),
           completed = COALESCE($5, completed),
           related_type = COALESCE($6, related_type),
           related_id = COALESCE($7, related_id)
       WHERE id = $8 ${scope ? `AND ${scope}` : ''}
       RETURNING *`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Activity not found' });
      return;
    }

    res.json({ activity: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update activity');
  }
});

// DELETE /api/activities/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Activity not found');
    const params: unknown[] = [req.params.id];
    const scope = ownerScope(callerFrom(req), 'activities', params);
    const result = await pool.query(
      `DELETE FROM activities WHERE id = $1 ${scope ? `AND ${scope}` : ''} RETURNING id`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Activity not found' });
      return;
    }

    res.json({ message: 'Activity deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete activity');
  }
});

export default router;
