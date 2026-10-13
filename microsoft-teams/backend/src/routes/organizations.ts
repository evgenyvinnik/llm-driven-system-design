import { Router, Request, Response } from 'express';
import { pool, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { ASSIGNABLE_ORG_ROLES, canManageOrg, getOrgRole, isUuid } from '../services/access.js';
import { logger } from '../services/logger.js';

const router = Router();

/** The caller's role in the org named by the route; answers 404 for non-members. */
async function memberRole(req: Request, res: Response): Promise<string | null> {
  const role = await getOrgRole(req.session.userId!, req.params.orgId);
  if (!role) res.status(404).json({ error: 'Organization not found' });
  return role;
}

// GET /api/organizations - list user's organizations
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT o.*, om.role as member_role
       FROM organizations o
       JOIN org_members om ON o.id = om.org_id
       WHERE om.user_id = $1
       ORDER BY o.name`,
      [req.session.userId],
    );
    res.json({ organizations: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list organizations');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organizations - create organization (the creator becomes its owner)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;

    if (typeof name !== 'string' || !name.trim() || name.length > 100) {
      res.status(400).json({ error: 'Name is required (max 100 characters)' });
      return;
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const org = await withTransaction(async (client) => {
      const orgResult = await client.query(
        `INSERT INTO organizations (name, slug, description, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [name.trim(), slug, description || null, req.session.userId],
      );

      // Add creator as owner
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [orgResult.rows[0].id, req.session.userId],
      );
      return orgResult.rows[0];
    });

    res.status(201).json({ organization: org });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'An organization with this name already exists' });
      return;
    }
    logger.error({ err }, 'Failed to create organization');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/organizations/:orgId - get organization details (members only)
router.get('/:orgId', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await memberRole(req, res))) return;
    const result = await pool.query('SELECT * FROM organizations WHERE id = $1', [
      req.params.orgId,
    ]);
    res.json({ organization: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get organization');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/organizations/:orgId/members - list org members (members only)
router.get('/:orgId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!(await memberRole(req, res))) return;
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, om.role, om.joined_at
       FROM org_members om
       JOIN users u ON om.user_id = u.id
       WHERE om.org_id = $1
       ORDER BY u.display_name`,
      [req.params.orgId],
    );
    res.json({ members: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list org members');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/organizations/:orgId/members - add member to org (owners and admins only)
router.post('/:orgId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId, role = 'member' } = req.body;

    if (!isUuid(userId) || !ASSIGNABLE_ORG_ROLES.has(role)) {
      res.status(400).json({ error: 'userId is required and role must be member or admin' });
      return;
    }

    const callerRole = await memberRole(req, res);
    if (!callerRole) return;
    if (!canManageOrg(callerRole)) {
      res.status(403).json({ error: 'Only organization owners and admins can add members' });
      return;
    }

    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [req.params.orgId, userId, role],
    );

    res.status(201).json({ message: 'Member added' });
  } catch (err) {
    if ((err as { code?: string }).code === '23503') {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    logger.error({ err }, 'Failed to add org member');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
