import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { respondError } from '../services/errors.js';
import { requireProject } from '../services/projectAccess.js';
import { parseProjectInput, updateProject } from '../services/projectService.js';

const router = Router();

function settingsDto(r: Record<string, unknown>) {
  // No db_password: the client can set it but never read it back.
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    dbHost: r.db_host,
    dbPort: r.db_port,
    dbName: r.db_name,
    dbUser: r.db_user,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/projects/:projectId/settings — any member may read (password excluded)
router.get('/:projectId/settings', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const result = await pool.query(
      `SELECT id, name, description, db_host, db_port, db_name, db_user, created_at, updated_at
       FROM projects
       WHERE id = $1`,
      [access.projectId],
    );
    res.json({ settings: settingsDto(result.rows[0]) });
  } catch (err) {
    respondError(res, err, 'Failed to get project settings');
  }
});

// PUT /api/projects/:projectId/settings — owners only
router.put('/:projectId/settings', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'own');
    const row = await updateProject(access.projectId, parseProjectInput(req.body, { partial: true }));
    res.json({ settings: settingsDto(row) });
  } catch (err) {
    respondError(res, err, 'Failed to update project settings');
  }
});

/** Settings router for reading and updating project database connection configuration. */
export default router;
