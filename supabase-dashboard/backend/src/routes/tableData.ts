import { Router, Request, Response } from 'express';
import type pg from 'pg';
import { requireAuth } from '../middleware/auth.js';
import { runStatement, withTargetClient } from '../services/queryExecutor.js';
import { getTableKeyInfo, type TableKeyInfo } from '../services/schemaIntrospector.js';
import { qualifiedTable, quoteIdent } from '../services/sqlIdentifiers.js';
import { ApiError, respondError } from '../services/errors.js';
import { requireProject } from '../services/projectAccess.js';

/*
 * Row CRUD for the table browser. Identifiers (table, columns) are quoted with
 * quoteIdent — they can't be parameters — and every value is a bound `$N`
 * parameter. Table and column names are checked against the live schema first,
 * so a missing table is a 404 and a misspelled column a 400, and updates and
 * deletes address rows by the table's real single-column primary key.
 */

const router = Router();

async function requireTable(client: pg.ClientBase, tableName: string): Promise<TableKeyInfo> {
  const info = await getTableKeyInfo(client, tableName);
  if (!info) throw new ApiError(404, `Table "${tableName}" not found`);
  return info;
}

function requireRowData(data: unknown, allowEmpty: boolean): [string, unknown][] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError(400, 'data object is required');
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (!allowEmpty && entries.length === 0) throw new ApiError(400, 'data must contain at least one column');
  return entries;
}

function requireKnownColumns(info: TableKeyInfo, names: string[]): void {
  const unknown = names.filter((n) => !info.columns.includes(n));
  if (unknown.length > 0) throw new ApiError(400, `Unknown column(s): ${unknown.join(', ')}`);
}

/** The table's single primary-key column, or a 400: without one, "this row" isn't well defined. */
function singlePrimaryKey(info: TableKeyInfo, tableName: string): string {
  if (info.primaryKey.length !== 1) {
    throw new ApiError(
      400,
      info.primaryKey.length === 0
        ? `Table "${tableName}" has no primary key; edit its rows from the SQL editor`
        : `Table "${tableName}" has a composite primary key; edit its rows from the SQL editor`,
    );
  }
  return info.primaryKey[0];
}

// GET /api/projects/:projectId/tables/:tableName/rows
router.get('/:projectId/tables/:tableName/rows', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const tableName = req.params.tableName;
    const table = qualifiedTable(tableName);
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 50), 200);
    const offset = (page - 1) * limit;
    const sortBy = typeof req.query.sortBy === 'string' && req.query.sortBy !== '' ? req.query.sortBy : null;
    const sortOrder = req.query.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const data = await withTargetClient(access.projectId, access.connection(), async (client) => {
      const info = await requireTable(client, tableName);
      if (sortBy) requireKnownColumns(info, [sortBy]);

      const countResult = await runStatement(client, `SELECT COUNT(*) AS total FROM ${table}`);
      const orderClause = sortBy ? `ORDER BY ${quoteIdent(sortBy, 'sort column')} ${sortOrder}` : '';
      const result = await runStatement(client, `SELECT * FROM ${table} ${orderClause} LIMIT $1 OFFSET $2`, [
        limit,
        offset,
      ]);
      return { result, total: parseInt(countResult.rows[0]?.total as string, 10) || 0 };
    });

    res.json({
      rows: data.result.rows,
      fields: data.result.fields,
      total: data.total,
      page,
      limit,
      totalPages: Math.ceil(data.total / limit),
    });
  } catch (err) {
    respondError(res, err, 'Failed to fetch table data');
  }
});

// POST /api/projects/:projectId/tables/:tableName/rows
router.post('/:projectId/tables/:tableName/rows', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const tableName = req.params.tableName;
    const table = qualifiedTable(tableName);
    const entries = requireRowData(req.body?.data, true);

    const row = await withTargetClient(access.projectId, access.connection(), async (client) => {
      const info = await requireTable(client, tableName);
      requireKnownColumns(info, entries.map(([k]) => k));

      const sql =
        entries.length === 0
          ? `INSERT INTO ${table} DEFAULT VALUES RETURNING *`
          : `INSERT INTO ${table} (${entries.map(([k]) => quoteIdent(k, 'column name')).join(', ')}) ` +
            `VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
      const result = await runStatement(client, sql, entries.map(([, v]) => v));
      return result.rows[0];
    });

    res.status(201).json({ row });
  } catch (err) {
    respondError(res, err, 'Failed to insert row');
  }
});

// PUT /api/projects/:projectId/tables/:tableName/rows/:id
router.put('/:projectId/tables/:tableName/rows/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const tableName = req.params.tableName;
    const table = qualifiedTable(tableName);
    const entries = requireRowData(req.body?.data, false);

    const result = await withTargetClient(access.projectId, access.connection(), async (client) => {
      const info = await requireTable(client, tableName);
      requireKnownColumns(info, entries.map(([k]) => k));
      // The real key, not the client's `primaryKey` hint.
      const pk = singlePrimaryKey(info, tableName);

      const setClauses = entries.map(([k], i) => `${quoteIdent(k, 'column name')} = $${i + 1}`).join(', ');
      const sql = `UPDATE ${table} SET ${setClauses} WHERE ${quoteIdent(pk)} = $${entries.length + 1} RETURNING *`;
      return runStatement(client, sql, [...entries.map(([, v]) => v), req.params.id]);
    });

    if (result.rowCount === 0) throw new ApiError(404, 'Row not found');
    res.json({ row: result.rows[0] });
  } catch (err) {
    respondError(res, err, 'Failed to update row');
  }
});

// DELETE /api/projects/:projectId/tables/:tableName/rows/:id
router.delete('/:projectId/tables/:tableName/rows/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const tableName = req.params.tableName;
    const table = qualifiedTable(tableName);

    const result = await withTargetClient(access.projectId, access.connection(), async (client) => {
      const pk = singlePrimaryKey(await requireTable(client, tableName), tableName);
      return runStatement(client, `DELETE FROM ${table} WHERE ${quoteIdent(pk)} = $1`, [req.params.id]);
    });

    if (result.rowCount === 0) throw new ApiError(404, 'Row not found');
    res.json({ message: 'Row deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete row');
  }
});

/** Table data router for paginated row queries, inserts, updates, and deletes. */
export default router;
