import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  callerFrom,
  isUuid,
  ownerScope,
  requireRecord,
  requireReference,
  respondError,
  whereClause,
  HttpError,
} from '../services/accessPolicy.js';
import { containsPattern, parsePagination, queryString } from '../services/queryParams.js';

const router = Router();

// GET /api/contacts
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const { page, limit, offset } = parsePagination(req.query, 20);
    const search = queryString(req.query.search);
    const accountId = queryString(req.query.accountId);
    if (accountId !== undefined && !isUuid(accountId)) {
      throw new HttpError(400, 'accountId must be a UUID');
    }
    const params: unknown[] = [];
    const conditions: (string | null)[] = [ownerScope(caller, 'c', params)];

    if (search) {
      params.push(containsPattern(search));
      conditions.push(`(c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
    }
    if (accountId) {
      params.push(accountId);
      conditions.push(`c.account_id = $${params.length}`);
    }

    const where = whereClause(conditions);
    const countParams = [...params];
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT c.*, a.name as account_name, u.display_name as owner_name
       FROM contacts c
       LEFT JOIN accounts a ON c.account_id = a.id
       LEFT JOIN users u ON c.owner_id = u.id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const countResult = await pool.query(`SELECT COUNT(*) FROM contacts c ${where}`, countParams);

    res.json({
      contacts: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    respondError(res, err, 'Failed to fetch contacts');
  }
});

// GET /api/contacts/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const record = await requireRecord('contact', req.params.id, callerFrom(req));
    const result = await pool.query(
      `SELECT c.*, a.name as account_name, u.display_name as owner_name
       FROM contacts c
       LEFT JOIN accounts a ON c.account_id = a.id
       LEFT JOIN users u ON c.owner_id = u.id
       WHERE c.id = $1`,
      [record.id],
    );
    res.json({ contact: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to fetch contact');
  }
});

// POST /api/contacts
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, phone, title, department } = req.body;
    const accountId = req.body.accountId || null;

    if (!firstName || !lastName) {
      res.status(400).json({ error: 'First name and last name are required' });
      return;
    }
    // A contact can only be attached to an account the caller can see;
    // otherwise any rep could hang records off another rep's account.
    if (accountId) await requireReference('account', accountId, callerFrom(req));

    const result = await pool.query(
      `INSERT INTO contacts (first_name, last_name, email, phone, title, department, account_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [firstName, lastName, email, phone, title, department, accountId, req.session.userId],
    );

    res.status(201).json({ contact: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to create contact');
  }
});

// PUT /api/contacts/:id
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Contact not found');
    const caller = callerFrom(req);
    const { firstName, lastName, email, phone, title, department } = req.body;
    const accountId = req.body.accountId || null;
    if (accountId) await requireReference('account', accountId, caller);

    const params: unknown[] = [firstName, lastName, email, phone, title, department, accountId, req.params.id];
    const scope = ownerScope(caller, 'contacts', params);

    const result = await pool.query(
      `UPDATE contacts
       SET first_name = COALESCE($1, first_name),
           last_name = COALESCE($2, last_name),
           email = COALESCE($3, email),
           phone = COALESCE($4, phone),
           title = COALESCE($5, title),
           department = COALESCE($6, department),
           account_id = COALESCE($7, account_id),
           updated_at = NOW()
       WHERE id = $8 ${scope ? `AND ${scope}` : ''}
       RETURNING *`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    res.json({ contact: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update contact');
  }
});

// DELETE /api/contacts/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Contact not found');
    const params: unknown[] = [req.params.id];
    const scope = ownerScope(callerFrom(req), 'contacts', params);
    const result = await pool.query(
      `DELETE FROM contacts WHERE id = $1 ${scope ? `AND ${scope}` : ''} RETURNING id`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Contact not found' });
      return;
    }

    res.json({ message: 'Contact deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete contact');
  }
});

export default router;
