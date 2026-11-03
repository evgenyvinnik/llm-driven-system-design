import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  callerFrom,
  isAdmin,
  isUuid,
  ownerScope,
  requireRecord,
  requireReference,
  respondError,
  whereClause,
  canAccess,
  HttpError,
  type Caller,
} from '../services/accessPolicy.js';
import {
  containsPattern,
  optionalDate,
  optionalNonNegativeInt,
  parsePagination,
  queryString,
} from '../services/queryParams.js';
import {
  closedAtSql,
  isValidStage,
  planNewOpportunity,
  planStageChange,
  VALID_STAGES,
} from '../services/opportunityStages.js';

const router = Router();

interface OpportunityRow {
  id: string;
  stage: string;
  probability: number;
  owner_id: string | null;
}

/** The current stage and probability of an opportunity the caller can see, or 404. */
async function loadForWrite(id: unknown, caller: Caller): Promise<OpportunityRow> {
  const notFound = new HttpError(404, 'Opportunity not found');
  if (!isUuid(id)) throw notFound;
  const result = await pool.query(
    'SELECT id, stage, probability, owner_id FROM opportunities WHERE id = $1',
    [id],
  );
  const row = result.rows[0] as OpportunityRow | undefined;
  if (!row || !canAccess(row, caller)) throw notFound;
  return row;
}

const staleStage = () =>
  new HttpError(409, 'This opportunity was changed by someone else. Reload and try again.');

// GET /api/opportunities
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const { page, limit, offset } = parsePagination(req.query, 50);
    const search = queryString(req.query.search);
    const stage = queryString(req.query.stage);
    const accountId = queryString(req.query.accountId);
    if (stage !== undefined && !isValidStage(stage)) {
      throw new HttpError(400, `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}`);
    }
    if (accountId !== undefined && !isUuid(accountId)) {
      throw new HttpError(400, 'accountId must be a UUID');
    }
    const params: unknown[] = [];
    const conditions: (string | null)[] = [ownerScope(caller, 'o', params)];

    if (search) {
      params.push(containsPattern(search));
      conditions.push(`o.name ILIKE $${params.length}`);
    }
    if (stage) {
      params.push(stage);
      conditions.push(`o.stage = $${params.length}`);
    }
    if (accountId) {
      params.push(accountId);
      conditions.push(`o.account_id = $${params.length}`);
    }

    const where = whereClause(conditions);
    const countParams = [...params];
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT o.*, a.name as account_name, u.display_name as owner_name
       FROM opportunities o
       LEFT JOIN accounts a ON o.account_id = a.id
       LEFT JOIN users u ON o.owner_id = u.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const countResult = await pool.query(`SELECT COUNT(*) FROM opportunities o ${where}`, countParams);

    res.json({
      opportunities: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    respondError(res, err, 'Failed to fetch opportunities');
  }
});

// GET /api/opportunities/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const record = await requireRecord('opportunity', req.params.id, callerFrom(req));
    const result = await pool.query(
      `SELECT o.*, a.name as account_name, u.display_name as owner_name
       FROM opportunities o
       LEFT JOIN accounts a ON o.account_id = a.id
       LEFT JOIN users u ON o.owner_id = u.id
       WHERE o.id = $1`,
      [record.id],
    );
    res.json({ opportunity: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to fetch opportunity');
  }
});

// POST /api/opportunities
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    const accountId = req.body.accountId || null;

    if (!name) {
      res.status(400).json({ error: 'Opportunity name is required' });
      return;
    }

    const plan = planNewOpportunity(req.body.stage, req.body.probability);
    const amountCents = optionalNonNegativeInt(req.body.amountCents, 'amountCents');
    const closeDate = optionalDate(req.body.closeDate, 'closeDate');
    if (accountId) await requireReference('account', accountId, callerFrom(req));

    const result = await pool.query(
      `INSERT INTO opportunities (name, account_id, amount_cents, stage, probability, close_date, description, owner_id, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${plan.closedAt === 'set' ? 'NOW()' : 'NULL'})
       RETURNING *`,
      [name, accountId, amountCents, plan.stage, plan.probability, closeDate, description, req.session.userId],
    );

    res.status(201).json({ opportunity: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to create opportunity');
  }
});

// PUT /api/opportunities/:id
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const current = await loadForWrite(req.params.id, caller);
    const { name, description } = req.body;
    const accountId = req.body.accountId || null;
    const amountCents = optionalNonNegativeInt(req.body.amountCents, 'amountCents');
    const closeDate = optionalDate(req.body.closeDate, 'closeDate');
    const plan = planStageChange({
      currentStage: current.stage,
      currentProbability: current.probability,
      nextStage: req.body.stage,
      probability: req.body.probability,
      isAdmin: isAdmin(caller),
    });
    if (accountId) await requireReference('account', accountId, caller);

    // `AND stage = $10` makes the write conditional on the stage the plan was
    // computed from: if another request moved the deal in between, this
    // updates nothing and the caller gets a 409 instead of a lost update.
    const result = await pool.query(
      `UPDATE opportunities
       SET name = COALESCE($1, name),
           account_id = COALESCE($2, account_id),
           amount_cents = COALESCE($3, amount_cents),
           stage = $4,
           probability = $5,
           close_date = COALESCE($6, close_date),
           description = COALESCE($7, description),
           closed_at = ${closedAtSql(plan)},
           updated_at = NOW()
       WHERE id = $8 AND stage = $9
       RETURNING *`,
      [name, accountId, amountCents, plan.stage, plan.probability, closeDate, description, current.id, current.stage],
    );

    if (result.rows.length === 0) throw staleStage();

    res.json({ opportunity: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update opportunity');
  }
});

// PUT /api/opportunities/:id/stage - Kanban drag-drop stage update
router.put('/:id/stage', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    if (!isValidStage(req.body.stage)) {
      throw new HttpError(400, `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}`);
    }
    const current = await loadForWrite(req.params.id, caller);
    // The kanban path never takes a probability: the server owns the mapping.
    const plan = planStageChange({
      currentStage: current.stage,
      currentProbability: current.probability,
      nextStage: req.body.stage,
      isAdmin: isAdmin(caller),
    });

    if (plan.noop) {
      // Dropping a card back on its own column is idempotent: no write, no
      // updated_at bump.
      const unchanged = await pool.query('SELECT * FROM opportunities WHERE id = $1', [current.id]);
      res.json({ opportunity: unchanged.rows[0] });
      return;
    }

    const result = await pool.query(
      `UPDATE opportunities
       SET stage = $1, probability = $2, closed_at = ${closedAtSql(plan)}, updated_at = NOW()
       WHERE id = $3 AND stage = $4
       RETURNING *`,
      [plan.stage, plan.probability, current.id, current.stage],
    );

    if (result.rows.length === 0) throw staleStage();

    res.json({ opportunity: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update opportunity stage');
  }
});

// DELETE /api/opportunities/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Opportunity not found');
    const params: unknown[] = [req.params.id];
    const scope = ownerScope(callerFrom(req), 'opportunities', params);
    const result = await pool.query(
      `DELETE FROM opportunities WHERE id = $1 ${scope ? `AND ${scope}` : ''} RETURNING id`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Opportunity not found' });
      return;
    }

    res.json({ message: 'Opportunity deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete opportunity');
  }
});

export default router;
