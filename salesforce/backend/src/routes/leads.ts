import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { convertLead } from '../services/leadConversionService.js';
import {
  callerFrom,
  isUuid,
  ownerScope,
  requireRecord,
  respondError,
  whereClause,
  HttpError,
} from '../services/accessPolicy.js';
import { containsPattern, optionalDate, parsePagination, queryString } from '../services/queryParams.js';

const router = Router();

const VALID_STATUSES = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'];
/**
 * 'Converted' is set only by POST /:id/convert, together with the converted_*
 * links and converted_at. Allowing it on create/update produced leads that
 * looked converted (no Convert button) but had no account, no contact, and
 * didn't count in the conversion rate.
 */
const EDITABLE_STATUSES = VALID_STATUSES.filter((s) => s !== 'Converted');
const VALID_SOURCES = ['Web', 'Phone', 'Email', 'Referral', 'Partner', 'Trade Show', 'Social Media', 'Other'];

// GET /api/leads
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const { page, limit, offset } = parsePagination(req.query, 20);
    const search = queryString(req.query.search);
    const status = queryString(req.query.status);
    const source = queryString(req.query.source);
    const params: unknown[] = [];
    const conditions: (string | null)[] = [ownerScope(caller, 'l', params)];

    if (search) {
      params.push(containsPattern(search));
      conditions.push(`(l.first_name ILIKE $${params.length} OR l.last_name ILIKE $${params.length} OR l.company ILIKE $${params.length} OR l.email ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }
    if (source) {
      params.push(source);
      conditions.push(`l.source = $${params.length}`);
    }

    const where = whereClause(conditions);
    const countParams = [...params];
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT l.*, u.display_name as owner_name
       FROM leads l
       LEFT JOIN users u ON l.owner_id = u.id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const countResult = await pool.query(`SELECT COUNT(*) FROM leads l ${where}`, countParams);

    res.json({
      leads: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    respondError(res, err, 'Failed to fetch leads');
  }
});

// GET /api/leads/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const record = await requireRecord('lead', req.params.id, callerFrom(req));
    const result = await pool.query(
      `SELECT l.*, u.display_name as owner_name
       FROM leads l
       LEFT JOIN users u ON l.owner_id = u.id
       WHERE l.id = $1`,
      [record.id],
    );
    res.json({ lead: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to fetch lead');
  }
});

// POST /api/leads
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, phone, company, title, status } = req.body;
    const source = req.body.source || null;

    if (!firstName || !lastName) {
      res.status(400).json({ error: 'First name and last name are required' });
      return;
    }

    const leadStatus = status || 'New';
    if (!EDITABLE_STATUSES.includes(leadStatus)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${EDITABLE_STATUSES.join(', ')}` });
      return;
    }

    if (source && !VALID_SOURCES.includes(source)) {
      res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
      return;
    }

    const result = await pool.query(
      `INSERT INTO leads (first_name, last_name, email, phone, company, title, source, status, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [firstName, lastName, email, phone, company, title, source, leadStatus, req.session.userId],
    );

    res.status(201).json({ lead: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to create lead');
  }
});

// PUT /api/leads/:id
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, phone, company, title, source, status } = req.body;
    const caller = callerFrom(req);

    if (status && !EDITABLE_STATUSES.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${EDITABLE_STATUSES.join(', ')}` });
      return;
    }

    if (source && !VALID_SOURCES.includes(source)) {
      res.status(400).json({ error: `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}` });
      return;
    }

    const record = await requireRecord('lead', req.params.id, caller);

    // A converted lead is a historical record of where the account came from;
    // the guard is in the UPDATE so a conversion racing this edit wins cleanly.
    const result = await pool.query(
      `UPDATE leads
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           email = COALESCE($3, email),
           phone = COALESCE($4, phone),
           company = COALESCE($5, company),
           title = COALESCE($6, title),
           source = COALESCE($7, source),
           status = COALESCE($8, status),
           updated_at = NOW()
       WHERE id = $9 AND converted_at IS NULL
       RETURNING *`,
      [firstName, lastName, email, phone, company, title, source, status, record.id],
    );

    if (result.rows.length === 0) {
      res.status(409).json({ error: 'Converted leads are read-only' });
      return;
    }

    res.json({ lead: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update lead');
  }
});

// POST /api/leads/:id/convert
router.post('/:id/convert', requireAuth, async (req: Request, res: Response) => {
  try {
    const { accountName, opportunityName } = req.body;

    // The modal sends dollars; convert once, here, to the integer cents the
    // schema stores. Rounding to the cent is the only float arithmetic.
    let opportunityAmountCents: number | undefined;
    const amount = req.body.opportunityAmount;
    if (amount !== undefined && amount !== null && amount !== '') {
      const dollars = typeof amount === 'string' ? Number(amount) : amount;
      if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars < 0) {
        throw new HttpError(400, 'opportunityAmount must be a non-negative number of dollars');
      }
      opportunityAmountCents = Math.round(dollars * 100);
      if (!Number.isSafeInteger(opportunityAmountCents)) {
        throw new HttpError(400, 'opportunityAmount is too large');
      }
    }
    const closeDate = optionalDate(req.body.closeDate, 'closeDate');
    if (accountName !== undefined && typeof accountName !== 'string') {
      throw new HttpError(400, 'accountName must be a string');
    }
    if (opportunityName !== undefined && opportunityName !== null && typeof opportunityName !== 'string') {
      throw new HttpError(400, 'opportunityName must be a string');
    }

    const result = await convertLead({
      leadId: req.params.id,
      accountName,
      opportunityName: opportunityName || undefined,
      opportunityAmountCents,
      closeDate,
      caller: callerFrom(req),
    });

    res.json({
      message: 'Lead converted successfully',
      ...result,
    });
  } catch (err) {
    respondError(res, err, 'Lead conversion failed');
  }
});

// DELETE /api/leads/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Lead not found');
    const params: unknown[] = [req.params.id];
    const scope = ownerScope(callerFrom(req), 'leads', params);
    const result = await pool.query(
      `DELETE FROM leads WHERE id = $1 ${scope ? `AND ${scope}` : ''} RETURNING id`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    res.json({ message: 'Lead deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete lead');
  }
});

export default router;
