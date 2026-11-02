import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  callerFrom,
  isUuid,
  ownerScope,
  requireRecord,
  respondError,
  whereClause,
  HttpError,
} from '../services/accessPolicy.js';
import {
  containsPattern,
  optionalNonNegativeInt,
  parsePagination,
  queryString,
} from '../services/queryParams.js';

const router = Router();

// GET /api/accounts
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const { page, limit, offset } = parsePagination(req.query, 20);
    const search = queryString(req.query.search);
    const industry = queryString(req.query.industry);
    const params: unknown[] = [];
    const conditions: (string | null)[] = [ownerScope(caller, 'a', params)];

    if (search) {
      params.push(containsPattern(search));
      conditions.push(`a.name ILIKE $${params.length}`);
    }
    if (industry) {
      params.push(industry);
      conditions.push(`a.industry = $${params.length}`);
    }

    const where = whereClause(conditions);
    const countParams = [...params];
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT a.*, u.display_name as owner_name
       FROM accounts a
       LEFT JOIN users u ON a.owner_id = u.id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const countResult = await pool.query(`SELECT COUNT(*) FROM accounts a ${where}`, countParams);

    res.json({
      accounts: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    respondError(res, err, 'Failed to fetch accounts');
  }
});

// GET /api/accounts/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const record = await requireRecord('account', req.params.id, callerFrom(req));
    const result = await pool.query(
      `SELECT a.*, u.display_name as owner_name
       FROM accounts a
       LEFT JOIN users u ON a.owner_id = u.id
       WHERE a.id = $1`,
      [record.id],
    );
    res.json({ account: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to fetch account');
  }
});

// POST /api/accounts
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      name, industry, website, phone,
      addressStreet, addressCity, addressState, addressCountry,
    } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Account name is required' });
      return;
    }
    const annualRevenueCents = optionalNonNegativeInt(req.body.annualRevenueCents, 'annualRevenueCents');
    const employeeCount = optionalNonNegativeInt(req.body.employeeCount, 'employeeCount');

    const result = await pool.query(
      `INSERT INTO accounts (name, industry, website, phone, address_street, address_city, address_state, address_country, annual_revenue_cents, employee_count, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [name, industry, website, phone, addressStreet, addressCity, addressState, addressCountry, annualRevenueCents, employeeCount, req.session.userId],
    );

    res.status(201).json({ account: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to create account');
  }
});

// PUT /api/accounts/:id
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Account not found');
    const {
      name, industry, website, phone,
      addressStreet, addressCity, addressState, addressCountry,
    } = req.body;
    const annualRevenueCents = optionalNonNegativeInt(req.body.annualRevenueCents, 'annualRevenueCents');
    const employeeCount = optionalNonNegativeInt(req.body.employeeCount, 'employeeCount');

    const params: unknown[] = [name, industry, website, phone, addressStreet, addressCity, addressState, addressCountry, annualRevenueCents, employeeCount, req.params.id];
    // The ownership check is part of the UPDATE itself, so there is no window
    // between "may this caller edit it?" and the write.
    const scope = ownerScope(callerFrom(req), 'accounts', params);

    const result = await pool.query(
      `UPDATE accounts
       SET name = COALESCE($1, name),
           industry = COALESCE($2, industry),
           website = COALESCE($3, website),
           phone = COALESCE($4, phone),
           address_street = COALESCE($5, address_street),
           address_city = COALESCE($6, address_city),
           address_state = COALESCE($7, address_state),
           address_country = COALESCE($8, address_country),
           annual_revenue_cents = COALESCE($9, annual_revenue_cents),
           employee_count = COALESCE($10, employee_count),
           updated_at = NOW()
       WHERE id = $11 ${scope ? `AND ${scope}` : ''}
       RETURNING *`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    res.json({ account: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update account');
  }
});

// DELETE /api/accounts/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Account not found');
    const params: unknown[] = [req.params.id];
    const scope = ownerScope(callerFrom(req), 'accounts', params);
    // Contacts and opportunities keep their rows (account_id SET NULL); a lead
    // converted into this account keeps its history (converted_account_id SET NULL).
    const result = await pool.query(
      `DELETE FROM accounts WHERE id = $1 ${scope ? `AND ${scope}` : ''} RETURNING id`,
      params,
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    res.json({ message: 'Account deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete account');
  }
});

// GET /api/accounts/:id/contacts
router.get('/:id/contacts', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const account = await requireRecord('account', req.params.id, caller);
    const params: unknown[] = [account.id];
    const where = whereClause(['c.account_id = $1', ownerScope(caller, 'c', params)]);
    const result = await pool.query(
      `SELECT c.*, u.display_name as owner_name
       FROM contacts c
       LEFT JOIN users u ON c.owner_id = u.id
       ${where}
       ORDER BY c.created_at DESC`,
      params,
    );

    res.json({ contacts: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to fetch account contacts');
  }
});

// GET /api/accounts/:id/opportunities
router.get('/:id/opportunities', requireAuth, async (req: Request, res: Response) => {
  try {
    const caller = callerFrom(req);
    const account = await requireRecord('account', req.params.id, caller);
    const params: unknown[] = [account.id];
    const where = whereClause(['o.account_id = $1', ownerScope(caller, 'o', params)]);
    const result = await pool.query(
      `SELECT o.*, u.display_name as owner_name
       FROM opportunities o
       LEFT JOIN users u ON o.owner_id = u.id
       ${where}
       ORDER BY o.created_at DESC`,
      params,
    );

    res.json({ opportunities: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to fetch account opportunities');
  }
});

export default router;
