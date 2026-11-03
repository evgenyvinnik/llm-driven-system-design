import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { pool, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { evictFromChannels } from '../services/pubsub.js';
import {
  AccessError,
  isUuid,
  requireOrgMember,
  respondError,
} from '../services/accessService.js';
import {
  assertCanGrant,
  changeRole,
  parseRole,
  removeMember,
} from '../services/membershipService.js';
import { validateName } from '../services/validation.js';

const router = Router();

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

// POST /api/organizations - create organization
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const name = validateName(req.body.name);
    const { description } = req.body;

    const base =
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'org';

    const org = await withTransaction(async (client) => {
      // Slugs are unique, so a second "Acme" used to fail with a raw 500.
      // ON CONFLICT DO NOTHING keeps the transaction alive; retry with a suffix.
      for (let attempt = 0; attempt < 5; attempt++) {
        const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
        const orgResult = await client.query(
          `INSERT INTO organizations (name, slug, description, created_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (slug) DO NOTHING
           RETURNING *`,
          [name, slug, description || null, req.session.userId],
        );
        if (orgResult.rows.length === 0) continue;
        const created = orgResult.rows[0];

        // Add creator as owner
        await client.query(
          `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [created.id, req.session.userId],
        );
        return created;
      }
      throw new AccessError(409, 'Could not allocate a unique slug; try another name');
    });

    res.status(201).json({ organization: { ...org, member_role: 'owner' } });
  } catch (err) {
    respondError(res, err, 'Failed to create organization');
  }
});

// GET /api/organizations/:orgId - get organization details (members only)
router.get('/:orgId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireOrgMember(req.params.orgId, req.session.userId!);
    const result = await pool.query('SELECT * FROM organizations WHERE id = $1', [access.orgId]);
    res.json({ organization: { ...result.rows[0], member_role: access.role } });
  } catch (err) {
    respondError(res, err, 'Failed to get organization');
  }
});

// GET /api/organizations/:orgId/members - list org members (members only)
router.get('/:orgId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireOrgMember(req.params.orgId, req.session.userId!);
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, om.role, om.joined_at
       FROM org_members om
       JOIN users u ON om.user_id = u.id
       WHERE om.org_id = $1
       ORDER BY u.display_name`,
      [access.orgId],
    );
    res.json({ members: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list org members');
  }
});

// POST /api/organizations/:orgId/members - add member to org
//
// Used to accept any signed-in user, any target and any role — anyone could
// add themselves to any tenant as its owner. Now: caller must be an org owner
// or admin, only owners hand out admin/owner, and the target must exist.
router.post('/:orgId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireOrgMember(req.params.orgId, req.session.userId!);
    const { userId } = req.body;
    if (!userId) throw new AccessError(400, 'userId is required');
    const role = parseRole(req.body.role);
    assertCanGrant(access.role, role);

    if (!isUuid(userId)) throw new AccessError(404, 'User not found');
    const user = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) throw new AccessError(404, 'User not found');

    const result = await pool.query(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO NOTHING
       RETURNING id`,
      [access.orgId, userId, role],
    );

    // Adding someone who is already a member is a no-op; roles change via PATCH.
    res
      .status(result.rows.length > 0 ? 201 : 200)
      .json({ message: result.rows.length > 0 ? 'Member added' : 'Already a member' });
  } catch (err) {
    respondError(res, err, 'Failed to add org member');
  }
});

// PATCH /api/organizations/:orgId/members/:userId - change a member's role (owners only)
router.patch('/:orgId/members/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireOrgMember(req.params.orgId, req.session.userId!);
    if (!isUuid(req.params.userId)) throw new AccessError(404, 'Member not found');
    if (req.body.role === undefined) throw new AccessError(400, 'role is required');
    const role = parseRole(req.body.role);
    await changeRole('org', access.orgId, req.params.userId, role, req.session.userId!);
    res.json({ message: 'Role updated' });
  } catch (err) {
    respondError(res, err, 'Failed to change org role');
  }
});

// DELETE /api/organizations/:orgId/members/:userId - leave (self) or remove a member
router.delete('/:orgId/members/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireOrgMember(req.params.orgId, req.session.userId!);
    if (!isUuid(req.params.userId)) throw new AccessError(404, 'Member not found');
    const { channelIds } = await removeMember(
      'org',
      access.orgId,
      req.params.userId,
      req.session.userId!,
    );
    await evictFromChannels(channelIds, req.params.userId);
    res.json({ message: 'Member removed' });
  } catch (err) {
    respondError(res, err, 'Failed to remove org member');
  }
});

export default router;
