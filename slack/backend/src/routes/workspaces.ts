/**
 * @fileoverview Workspace routes for multi-tenant workspace management.
 * Handles workspace CRUD, member management, and workspace selection.
 * Each workspace is isolated with its own channels and messages.
 * Includes RBAC for admin operations and cache invalidation.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, loadMembership } from '../middleware/rbac.js';
import { getCachedWorkspace, invalidateWorkspaceCache, invalidateChannelCache } from '../services/cache.js';
import { logger } from '../services/logger.js';
import type { Workspace, _WorkspaceMember } from '../types/index.js';

const router = Router();

/**
 * GET /workspaces - List all workspaces the current user is a member of.
 * Returns workspace details along with the user's role in each.
 */
router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<Workspace & { role: string }>(
      `SELECT w.*, wm.role FROM workspaces w
       INNER JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = $1
       ORDER BY w.name`,
      [req.session.userId]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error({ err: error, msg: 'Get workspaces error' });
    res.status(500).json({ error: 'Failed to get workspaces' });
  }
});

/**
 * POST /workspaces - Create a new workspace.
 * The creator becomes the workspace owner and default channels are created.
 */
router.post('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, domain } = req.body;

    if (!name || !domain) {
      res.status(400).json({ error: 'Name and domain are required' });
      return;
    }

    // Check if domain is taken
    const existing = await query('SELECT id FROM workspaces WHERE domain = $1', [domain.toLowerCase()]);
    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'Domain already taken' });
      return;
    }

    const workspaceId = uuidv4();

    // Create workspace
    await query(
      'INSERT INTO workspaces (id, name, domain) VALUES ($1, $2, $3)',
      [workspaceId, name, domain.toLowerCase()]
    );

    // Add creator as owner
    await query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [workspaceId, req.session.userId, 'owner']
    );

    // Create default channels
    const generalId = uuidv4();
    const randomId = uuidv4();

    await query(
      `INSERT INTO channels (id, workspace_id, name, topic, created_by) VALUES
       ($1, $2, 'general', 'Company-wide announcements and general discussions', $3),
       ($4, $2, 'random', 'Random fun stuff', $3)`,
      [generalId, workspaceId, req.session.userId, randomId]
    );

    // Add creator to default channels
    await query(
      'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $3), ($2, $3)',
      [generalId, randomId, req.session.userId]
    );

    // Set workspace context
    req.session.workspaceId = workspaceId;

    const result = await query<Workspace>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);

    logger.info({
      msg: 'Workspace created',
      workspaceId,
      name,
      domain: domain.toLowerCase(),
      createdBy: req.session.userId,
    });

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error({ err: error, msg: 'Create workspace error' });
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

/**
 * GET /workspaces/domain/:domain - Find a workspace by its domain.
 * Used for joining workspaces by URL. Returns limited public info.
 */
router.get('/domain/:domain', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await query<Workspace>(
      'SELECT id, name, domain FROM workspaces WHERE domain = $1',
      [req.params.domain.toLowerCase()]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error({ err: error, msg: 'Get workspace by domain error' });
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

/**
 * GET /workspaces/:id - Get detailed information about a specific workspace.
 * Uses cache for faster lookups.
 * Requires membership in the workspace.
 */
router.get('/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    // Check membership
    const membership = await query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );

    if (membership.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    // Use cache for workspace data
    const workspace = await getCachedWorkspace(req.params.id);

    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    res.json({ ...workspace, role: (membership.rows[0] as { role: string }).role });
  } catch (error) {
    logger.error({ err: error, msg: 'Get workspace error' });
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

/**
 * PUT /workspaces/:id - Update workspace settings.
 * Only workspace owners can update settings.
 * Invalidates cache after update.
 */
router.put(
  '/:id',
  requireAuth,
  requireRole('owner'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, settings } = req.body;

      const result = await query<Workspace>(
        `UPDATE workspaces SET
           name = COALESCE($1, name),
           settings = COALESCE($2, settings),
           updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [name, settings ? JSON.stringify(settings) : null, req.params.id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }

      // Invalidate cache
      await invalidateWorkspaceCache(req.params.id);

      logger.info({
        msg: 'Workspace updated',
        workspaceId: req.params.id,
        updatedBy: req.session.userId,
      });

      res.json(result.rows[0]);
    } catch (error) {
      logger.error({ err: error, msg: 'Update workspace error' });
      res.status(500).json({ error: 'Failed to update workspace' });
    }
  }
);

/**
 * POST /workspaces/:id/join - Join an existing workspace.
 * Adds user as a member and subscribes them to default channels.
 */
router.post('/:id/join', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const workspaceId = req.params.id;

    // Check if already a member
    const existing = await query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, req.session.userId]
    );

    if (existing.rows.length > 0) {
      res.status(400).json({ error: 'Already a member of this workspace' });
      return;
    }

    // Add as member
    await query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [workspaceId, req.session.userId, 'member']
    );

    // Add to general and random channels
    const channels = await query<{ id: string }>(
      "SELECT id FROM channels WHERE workspace_id = $1 AND name IN ('general', 'random')",
      [workspaceId]
    );

    for (const channel of channels.rows) {
      await query(
        'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [channel.id, req.session.userId]
      );
      // Invalidate channel members cache
      await invalidateChannelCache(channel.id);
    }

    req.session.workspaceId = workspaceId;

    logger.info({
      msg: 'User joined workspace',
      workspaceId,
      userId: req.session.userId,
    });

    res.json({ message: 'Joined workspace successfully' });
  } catch (error) {
    logger.error({ err: error, msg: 'Join workspace error' });
    res.status(500).json({ error: 'Failed to join workspace' });
  }
});

/**
 * POST /workspaces/:id/select - Set the active workspace in the session.
 * Required before making workspace-scoped API calls.
 */
router.post('/:id/select', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    // Verify membership
    const membership = await query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [req.params.id, req.session.userId]
    );

    if (membership.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    req.session.workspaceId = req.params.id;

    res.json({ message: 'Workspace selected', workspaceId: req.params.id });
  } catch (error) {
    logger.error({ err: error, msg: 'Select workspace error' });
    res.status(500).json({ error: 'Failed to select workspace' });
  }
});

/**
 * GET /workspaces/:id/members - List all members of a workspace.
 * Returns user profiles with their roles and join dates.
 */
router.get('/:id/members', requireAuth, loadMembership(), async (req: Request, res: Response): Promise<void> => {
  try {
    // Verify user is a member (loadMembership populates req.membership)
    if (!req.membership) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, wm.role, wm.joined_at
       FROM users u
       INNER JOIN workspace_members wm ON u.id = wm.user_id
       WHERE wm.workspace_id = $1
       ORDER BY u.display_name`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error({ err: error, msg: 'Get members error' });
    res.status(500).json({ error: 'Failed to get members' });
  }
});

/**
 * PUT /workspaces/:id/members/:userId - Update a member's role.
 * Only workspace owners can change roles.
 */
router.put(
  '/:id/members/:userId',
  requireAuth,
  requireRole('owner'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { role } = req.body;
      const { id: workspaceId, userId } = req.params;

      if (!['guest', 'member', 'admin', 'owner'].includes(role)) {
        res.status(400).json({ error: 'Invalid role. Must be guest, member, admin, or owner' });
        return;
      }

      // Prevent demoting yourself if you're the only owner
      if (userId === req.session.userId && role !== 'owner') {
        const owners = await query<{ count: string }>(
          "SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
          [workspaceId]
        );
        if (parseInt(owners.rows[0].count, 10) <= 1) {
          res.status(400).json({ error: 'Cannot demote the only owner' });
          return;
        }
      }

      const result = await query(
        `UPDATE workspace_members SET role = $1
         WHERE workspace_id = $2 AND user_id = $3
         RETURNING *`,
        [role, workspaceId, userId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }

      logger.info({
        msg: 'Member role updated',
        workspaceId,
        targetUserId: userId,
        newRole: role,
        updatedBy: req.session.userId,
      });

      res.json({ message: 'Role updated successfully', role });
    } catch (error) {
      logger.error({ err: error, msg: 'Update member role error' });
      res.status(500).json({ error: 'Failed to update role' });
    }
  }
);

/**
 * DELETE /workspaces/:id/members/:userId - Remove a member from the workspace.
 * Admins can remove members, owners can remove anyone except other owners.
 */
router.delete(
  '/:id/members/:userId',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id: workspaceId, userId } = req.params;

      // Check target user's role
      const targetMember = await query<{ role: string }>(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId]
      );

      if (targetMember.rows.length === 0) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }

      // Owners can only be removed by other owners
      if (targetMember.rows[0].role === 'owner' && req.membership?.role !== 'owner') {
        res.status(403).json({ error: 'Only owners can remove other owners' });
        return;
      }

      // Prevent removing yourself if you're the only owner
      if (userId === req.session.userId && targetMember.rows[0].role === 'owner') {
        const owners = await query<{ count: string }>(
          "SELECT COUNT(*) FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'",
          [workspaceId]
        );
        if (parseInt(owners.rows[0].count, 10) <= 1) {
          res.status(400).json({ error: 'Cannot remove the only owner' });
          return;
        }
      }

      // Remove from workspace
      await query(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId]
      );

      // Remove from all channels in this workspace
      await query(
        `DELETE FROM channel_members WHERE user_id = $1 AND channel_id IN (
           SELECT id FROM channels WHERE workspace_id = $2
         )`,
        [userId, workspaceId]
      );

      logger.info({
        msg: 'Member removed from workspace',
        workspaceId,
        removedUserId: userId,
        removedBy: req.session.userId,
      });

      res.json({ message: 'Member removed successfully' });
    } catch (error) {
      logger.error({ err: error, msg: 'Remove member error' });
      res.status(500).json({ error: 'Failed to remove member' });
    }
  }
);

export default router;
