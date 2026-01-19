import { Router, Request, Response } from 'express';
import { query } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

interface User {
  id: number;
  username: string;
  email: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  location: string | null;
  company: string | null;
  website: string | null;
  created_at: Date;
}

interface Organization {
  id: number;
  name: string;
  display_name: string;
  description: string | null;
  avatar_url: string | null;
  created_by: number;
  created_at: Date;
}

/**
 * Get user profile
 */
router.get('/:username', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;

  const result = await query(
    `SELECT id, username, email, display_name, bio, avatar_url, location, company, website, created_at
     FROM users WHERE username = $1`,
    [username]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const user = result.rows[0] as User;

  // Get repos count
  const reposResult = await query(
    'SELECT COUNT(*) FROM repositories WHERE owner_id = $1 AND is_private = FALSE',
    [user.id]
  );

  // Get starred repos count
  const starsResult = await query('SELECT COUNT(*) FROM stars WHERE user_id = $1', [user.id]);

  // Get organizations
  const orgsResult = await query(
    `SELECT o.* FROM organizations o
     JOIN organization_members om ON o.id = om.org_id
     WHERE om.user_id = $1`,
    [user.id]
  );

  res.json({
    ...user,
    public_repos: parseInt(reposResult.rows[0].count as string),
    starred_count: parseInt(starsResult.rows[0].count as string),
    organizations: orgsResult.rows,
  });
});

/**
 * Update current user profile
 */
router.patch('/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { displayName, bio, location, company, website, avatarUrl } = req.body as {
    displayName?: string;
    bio?: string;
    location?: string;
    company?: string;
    website?: string;
    avatarUrl?: string;
  };

  const updates: string[] = [];
  const params: unknown[] = [];

  if (displayName !== undefined) {
    params.push(displayName);
    updates.push(`display_name = $${params.length}`);
  }
  if (bio !== undefined) {
    params.push(bio);
    updates.push(`bio = $${params.length}`);
  }
  if (location !== undefined) {
    params.push(location);
    updates.push(`location = $${params.length}`);
  }
  if (company !== undefined) {
    params.push(company);
    updates.push(`company = $${params.length}`);
  }
  if (website !== undefined) {
    params.push(website);
    updates.push(`website = $${params.length}`);
  }
  if (avatarUrl !== undefined) {
    params.push(avatarUrl);
    updates.push(`avatar_url = $${params.length}`);
  }

  if (updates.length === 0) {
    res.json(req.user);
    return;
  }

  params.push(new Date());
  updates.push(`updated_at = $${params.length}`);

  params.push(req.user!.id);

  const result = await query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length}
     RETURNING id, username, email, display_name, bio, avatar_url, location, company, website`,
    params
  );

  res.json(result.rows[0]);
});

/**
 * Get user's repositories
 */
router.get('/:username/repos', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const { page = '1', limit = '20', sort = 'updated_at' } = req.query as { page?: string; limit?: string; sort?: string };

  const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);

  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const userId = userResult.rows[0].id as number;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const sortColumn = ['updated_at', 'created_at', 'stars_count', 'name'].includes(sort)
    ? sort
    : 'updated_at';

  const result = await query(
    `SELECT r.*, u.username as owner_name
     FROM repositories r
     JOIN users u ON r.owner_id = u.id
     WHERE r.owner_id = $1 AND r.is_private = FALSE
     ORDER BY r.${sortColumn} DESC
     LIMIT $2 OFFSET $3`,
    [userId, parseInt(limit), offset]
  );

  res.json(result.rows);
});

/**
 * Get user's starred repos
 */
router.get('/:username/starred', async (req: Request, res: Response): Promise<void> => {
  const { username } = req.params;
  const { page = '1', limit = '20' } = req.query as { page?: string; limit?: string };

  const userResult = await query('SELECT id FROM users WHERE username = $1', [username]);

  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const userId = userResult.rows[0].id as number;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const result = await query(
    `SELECT r.*, u.username as owner_name, s.created_at as starred_at
     FROM stars s
     JOIN repositories r ON s.repo_id = r.id
     JOIN users u ON r.owner_id = u.id
     WHERE s.user_id = $1 AND r.is_private = FALSE
     ORDER BY s.created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, parseInt(limit), offset]
  );

  res.json(result.rows);
});

/**
 * Get organizations
 */
router.get('/orgs', async (req: Request, res: Response): Promise<void> => {
  const { page = '1', limit = '20' } = req.query as { page?: string; limit?: string };
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const result = await query(
    `SELECT o.*,
            (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id) as members_count,
            (SELECT COUNT(*) FROM repositories WHERE org_id = o.id) as repos_count
     FROM organizations o
     ORDER BY o.created_at DESC
     LIMIT $1 OFFSET $2`,
    [parseInt(limit), offset]
  );

  res.json(result.rows);
});

/**
 * Get single organization
 */
router.get('/orgs/:name', async (req: Request, res: Response): Promise<void> => {
  const { name } = req.params;

  const result = await query(
    `SELECT o.*,
            (SELECT COUNT(*) FROM organization_members WHERE org_id = o.id) as members_count
     FROM organizations o WHERE o.name = $1`,
    [name]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ error: 'Organization not found' });
    return;
  }

  const org = result.rows[0] as Organization;

  // Get members
  const members = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, om.role
     FROM organization_members om
     JOIN users u ON om.user_id = u.id
     WHERE om.org_id = $1`,
    [org.id]
  );

  res.json({
    ...org,
    members: members.rows,
  });
});

/**
 * Create organization
 */
router.post('/orgs', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { name, displayName, description } = req.body as { name?: string; displayName?: string; description?: string };

  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    res.status(400).json({ error: 'Invalid organization name' });
    return;
  }

  // Check if name exists
  const existing = await query('SELECT id FROM organizations WHERE name = $1', [name]);

  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'Organization name already exists' });
    return;
  }

  const result = await query(
    `INSERT INTO organizations (name, display_name, description, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, displayName || name, description || null, req.user!.id]
  );

  const org = result.rows[0] as Organization;

  // Add creator as owner
  await query(
    'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
    [org.id, req.user!.id, 'owner']
  );

  res.status(201).json(org);
});

/**
 * Get org repositories
 */
router.get('/orgs/:name/repos', async (req: Request, res: Response): Promise<void> => {
  const { name } = req.params;
  const { page = '1', limit = '20' } = req.query as { page?: string; limit?: string };

  const orgResult = await query('SELECT id FROM organizations WHERE name = $1', [name]);

  if (orgResult.rows.length === 0) {
    res.status(404).json({ error: 'Organization not found' });
    return;
  }

  const orgId = orgResult.rows[0].id as number;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const result = await query(
    `SELECT r.*, o.name as owner_name
     FROM repositories r
     JOIN organizations o ON r.org_id = o.id
     WHERE r.org_id = $1 AND r.is_private = FALSE
     ORDER BY r.updated_at DESC
     LIMIT $2 OFFSET $3`,
    [orgId, parseInt(limit), offset]
  );

  res.json(result.rows);
});

export default router;
