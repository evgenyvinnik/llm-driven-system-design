import { Router, Request, Response } from 'express';
import { pool } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { removeTargetPool, resetCircuit, testConnection } from '../services/queryExecutor.js';
import { ApiError, respondError } from '../services/errors.js';
import { isProjectRole, isUuid, requireProject } from '../services/projectAccess.js';
import { createProject, parseProjectInput, projectDto, updateProject } from '../services/projectService.js';

const router = Router();

// GET /api/projects
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    // The creator is the owner even without a member row; otherwise the member row's role.
    const result = await pool.query(
      `SELECT p.id, p.name, p.description, p.db_host, p.db_port, p.db_name, p.db_user,
              p.created_by, p.created_at, p.updated_at,
              CASE WHEN p.created_by = $1 THEN 'owner' ELSE pm.role END AS member_role
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
       WHERE p.created_by = $1 OR pm.user_id = $1
       ORDER BY p.created_at DESC`,
      [req.session.userId],
    );

    res.json({ projects: result.rows.map((r) => projectDto(r, r.member_role)) });
  } catch (err) {
    respondError(res, err, 'Failed to list projects');
  }
});

// GET /api/projects/:id
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const result = await pool.query(
      `SELECT id, name, description, db_host, db_port, db_name, db_user, created_by, created_at, updated_at
       FROM projects WHERE id = $1`,
      [access.projectId],
    );
    res.json({ project: projectDto(result.rows[0], access.role) });
  } catch (err) {
    respondError(res, err, 'Failed to get project');
  }
});

// POST /api/projects
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const input = parseProjectInput(req.body, { partial: false });
    const project = await createProject(input, req.session.userId!);
    res.status(201).json({ project });
  } catch (err) {
    respondError(res, err, 'Failed to create project');
  }
});

// PUT /api/projects/:id
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'own');
    const row = await updateProject(access.projectId, parseProjectInput(req.body, { partial: true }));
    res.json({ project: projectDto(row, access.role) });
  } catch (err) {
    respondError(res, err, 'Failed to update project');
  }
});

// DELETE /api/projects/:id
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'own');
    await pool.query('DELETE FROM projects WHERE id = $1', [access.projectId]);
    // Otherwise the pool (and its connections to the target) outlive the project.
    removeTargetPool(access.projectId);
    res.json({ message: 'Project deleted' });
  } catch (err) {
    respondError(res, err, 'Failed to delete project');
  }
});

// POST /api/projects/:id/test-connection
router.post('/:id/test-connection', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const result = await testConnection(access.connection());
    // An explicit successful test is better evidence than the breaker's 30s timer.
    if (result.success) resetCircuit(access.projectId);
    res.json(result);
  } catch (err) {
    respondError(res, err, 'Connection test failed');
  }
});

// GET /api/projects/:id/members
router.get('/:id/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'view');
    const result = await pool.query(
      `SELECT pm.id, pm.user_id, pm.role, pm.joined_at, u.username, u.email, u.display_name
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1
       ORDER BY pm.joined_at`,
      [access.projectId],
    );

    const members = result.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      email: r.email,
      displayName: r.display_name,
      // The creator is the owner whatever their row says.
      role: r.user_id === access.createdBy ? 'owner' : r.role,
      isCreator: r.user_id === access.createdBy,
      joinedAt: r.joined_at,
    }));

    res.json({ members });
  } catch (err) {
    respondError(res, err, 'Failed to list members');
  }
});

// POST /api/projects/:id/members  { userId | username, role } — add or change a member's role
router.post('/:id/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireProject(req, 'own');
    const { userId, username } = req.body ?? {};
    const role = req.body?.role ?? 'editor';

    if (!isProjectRole(role)) {
      throw new ApiError(400, 'role must be owner, editor or viewer');
    }
    if (!isUuid(userId) && (typeof username !== 'string' || username.trim() === '')) {
      throw new ApiError(400, 'userId or username is required');
    }

    const userResult = isUuid(userId)
      ? await pool.query('SELECT id, username, email, display_name FROM users WHERE id = $1', [userId])
      : await pool.query('SELECT id, username, email, display_name FROM users WHERE username = $1', [username.trim()]);
    const user = userResult.rows[0];
    if (!user) throw new ApiError(404, 'User not found');
    if (user.id === access.createdBy && role !== 'owner') {
      throw new ApiError(400, "The project's creator is always an owner");
    }

    const result = await pool.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING id, role, joined_at`,
      [access.projectId, user.id, role],
    );

    const m = result.rows[0];
    res.status(201).json({
      member: {
        id: m.id,
        userId: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        role: m.role,
        isCreator: user.id === access.createdBy,
        joinedAt: m.joined_at,
      },
    });
  } catch (err) {
    respondError(res, err, 'Failed to add member');
  }
});

// DELETE /api/projects/:id/members/:userId — owners remove anyone; any member may leave
router.delete('/:id/members/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const leaving = req.params.userId === req.session.userId;
    const access = await requireProject(req, leaving ? 'view' : 'own');
    if (req.params.userId === access.createdBy) {
      throw new ApiError(400, "The project's creator can't be removed");
    }
    if (!isUuid(req.params.userId)) throw new ApiError(404, 'Member not found');

    const result = await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
      access.projectId,
      req.params.userId,
    ]);
    if ((result.rowCount ?? 0) === 0) throw new ApiError(404, 'Member not found');
    res.json({ message: 'Member removed' });
  } catch (err) {
    respondError(res, err, 'Failed to remove member');
  }
});

/** Projects router for CRUD, connection testing, and member management. */
export default router;
