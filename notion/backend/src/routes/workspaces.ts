import { Router, Request, Response } from 'express';
import pool from '../models/db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Workspace } from '../types/index.js';

const router = Router();

// All workspace routes require authentication
router.use(authMiddleware);

/**
 * GET /api/workspaces
 * Get all workspaces for current user
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await pool.query<Workspace>(
      `SELECT w.* FROM workspaces w
       JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = $1
       ORDER BY w.created_at`,
      [req.user!.id]
    );

    res.json({ workspaces: result.rows });
  } catch (error) {
    console.error('Get workspaces error:', error);
    res.status(500).json({ error: 'Failed to get workspaces' });
  }
});

/**
 * POST /api/workspaces
 * Create a new workspace
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, icon } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Workspace name is required' });
      return;
    }

    // Create workspace
    const result = await pool.query<Workspace>(
      `INSERT INTO workspaces (name, icon, owner_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, icon || '📁', req.user!.id]
    );

    const workspace = result.rows[0];

    // Add owner as admin
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [workspace.id, req.user!.id]
    );

    res.status(201).json({ workspace });
  } catch (error) {
    console.error('Create workspace error:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

/**
 * GET /api/workspaces/:id
 * Get a specific workspace
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if user is member
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const result = await pool.query<Workspace>(
      'SELECT * FROM workspaces WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    res.json({ workspace: result.rows[0], role: memberCheck.rows[0].role });
  } catch (error) {
    console.error('Get workspace error:', error);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

/**
 * PATCH /api/workspaces/:id
 * Update a workspace
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, icon, settings } = req.body;

    // Check if user is admin
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );

    if (memberCheck.rows.length === 0 || memberCheck.rows[0].role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (icon !== undefined) {
      updates.push(`icon = $${paramIndex++}`);
      values.push(icon);
    }
    if (settings !== undefined) {
      updates.push(`settings = $${paramIndex++}`);
      values.push(JSON.stringify(settings));
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    values.push(id);
    const result = await pool.query<Workspace>(
      `UPDATE workspaces SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    res.json({ workspace: result.rows[0] });
  } catch (error) {
    console.error('Update workspace error:', error);
    res.status(500).json({ error: 'Failed to update workspace' });
  }
});

/**
 * DELETE /api/workspaces/:id
 * Delete a workspace
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if user is owner
    const workspace = await pool.query<Workspace>(
      'SELECT * FROM workspaces WHERE id = $1',
      [id]
    );

    if (workspace.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    if (workspace.rows[0].owner_id !== req.user!.id) {
      res.status(403).json({ error: 'Only the owner can delete a workspace' });
      return;
    }

    await pool.query('DELETE FROM workspaces WHERE id = $1', [id]);

    res.json({ message: 'Workspace deleted' });
  } catch (error) {
    console.error('Delete workspace error:', error);
    res.status(500).json({ error: 'Failed to delete workspace' });
  }
});

/**
 * GET /api/workspaces/:id/members
 * Get workspace members
 */
router.get('/:id/members', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check if user is member
    const memberCheck = await pool.query(
      `SELECT role FROM workspace_members
       WHERE workspace_id = $1 AND user_id = $2`,
      [id, req.user!.id]
    );

    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.avatar_url, wm.role, wm.joined_at
       FROM users u
       JOIN workspace_members wm ON u.id = wm.user_id
       WHERE wm.workspace_id = $1
       ORDER BY wm.joined_at`,
      [id]
    );

    res.json({ members: result.rows });
  } catch (error) {
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

export default router;
