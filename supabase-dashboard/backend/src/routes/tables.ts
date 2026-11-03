import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { introspectTables, introspectIndexes } from '../services/schemaIntrospector.js';
import { generateCreateTable, generateAddColumn, generateDropColumn, generateRenameColumn, generateDropTable } from '../services/ddlGenerator.js';
import { executeQuery, withTargetClient } from '../services/queryExecutor.js';
import { ApiError, respondError } from '../services/errors.js';
import { requireProject } from '../services/projectAccess.js';

const router = Router();

// GET /api/projects/:projectId/tables
router.get('/:projectId/tables', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const tables = await withTargetClient(access.projectId, access.connection(), (client) => introspectTables(client));
    res.json({ tables });
  } catch (err) {
    respondError(res, err, 'Failed to introspect database schema');
  }
});

// GET /api/projects/:projectId/tables/:tableName/indexes
router.get('/:projectId/tables/:tableName/indexes', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const indexes = await withTargetClient(access.projectId, access.connection(), (client) =>
      introspectIndexes(client, req.params.tableName),
    );
    res.json({ indexes });
  } catch (err) {
    respondError(res, err, 'Failed to introspect indexes');
  }
});

// POST /api/projects/:projectId/tables
router.post('/:projectId/tables', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const { tableName, columns } = req.body ?? {};
    if (!tableName || !Array.isArray(columns) || columns.length === 0) {
      throw new ApiError(400, 'tableName and columns are required');
    }

    // Generation validates every slot and throws a 400 before anything reaches the target.
    const ddl = generateCreateTable(tableName, columns);
    await executeQuery(access.projectId, access.connection(), ddl);

    res.status(201).json({ message: `Table ${tableName} created`, sql: ddl });
  } catch (err) {
    respondError(res, err, 'Failed to create table');
  }
});

// PUT /api/projects/:projectId/tables/:tableName
router.put('/:projectId/tables/:tableName', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const { action, column, oldName, newName } = req.body ?? {};
    let ddl: string;

    switch (action) {
      case 'addColumn':
        if (!column) throw new ApiError(400, 'column definition is required');
        ddl = generateAddColumn(req.params.tableName, column);
        break;
      case 'dropColumn':
        if (!column?.name) throw new ApiError(400, 'column.name is required');
        ddl = generateDropColumn(req.params.tableName, column.name);
        break;
      case 'renameColumn':
        if (!oldName || !newName) throw new ApiError(400, 'oldName and newName are required');
        ddl = generateRenameColumn(req.params.tableName, oldName, newName);
        break;
      default:
        throw new ApiError(400, 'Invalid action. Use addColumn, dropColumn, or renameColumn');
    }

    await executeQuery(access.projectId, access.connection(), ddl);
    res.json({ message: `Table ${req.params.tableName} altered`, sql: ddl });
  } catch (err) {
    respondError(res, err, 'Failed to alter table');
  }
});

// DELETE /api/projects/:projectId/tables/:tableName
router.delete('/:projectId/tables/:tableName', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'edit');
    const ddl = generateDropTable(req.params.tableName);
    await executeQuery(access.projectId, access.connection(), ddl);
    res.json({ message: `Table ${req.params.tableName} dropped`, sql: ddl });
  } catch (err) {
    respondError(res, err, 'Failed to drop table');
  }
});

/** Tables router for schema introspection, table creation, alteration, and deletion. */
export default router;
