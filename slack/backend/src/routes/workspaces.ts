import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import type { Workspace, WorkspaceMember } from '../types/index.js';

const router = Router();

// Get user's workspaces
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
    console.error('Get workspaces error:', error);
    res.status(500).json({ error: 'Failed to get workspaces' });
  }
});

// Create workspace
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

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create workspace error:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

// Get workspace by domain (for joining)
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
    console.error('Get workspace error:', error);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

// Get workspace details
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

    const result = await query<Workspace>(
      'SELECT * FROM workspaces WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    res.json({ ...result.rows[0], role: membership.rows[0].role });
  } catch (error) {
    console.error('Get workspace error:', error);
    res.status(500).json({ error: 'Failed to get workspace' });
  }
});

// Join workspace
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
    }

    req.session.workspaceId = workspaceId;

    res.json({ message: 'Joined workspace successfully' });
  } catch (error) {
    console.error('Join workspace error:', error);
    res.status(500).json({ error: 'Failed to join workspace' });
  }
});

// Select workspace (set session context)
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
    console.error('Select workspace error:', error);
    res.status(500).json({ error: 'Failed to select workspace' });
  }
});

// Get workspace members
router.get('/:id/members', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
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
    console.error('Get members error:', error);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

export default router;
