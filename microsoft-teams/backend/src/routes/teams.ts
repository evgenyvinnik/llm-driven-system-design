import { Router, Request, Response } from 'express';
import { pool, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { evictFromChannels } from '../services/pubsub.js';
import {
  AccessError,
  isManager,
  isUuid,
  requireOrgMember,
  requireTeam,
  respondError,
} from '../services/accessService.js';
import {
  addTeamMember,
  assertCanGrant,
  changeRole,
  parseRole,
  removeMember,
} from '../services/membershipService.js';
import { validateName } from '../services/validation.js';

const router = Router();

// GET /api/teams?orgId=xxx - list teams in org (org members only)
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { orgId } = req.query;

    if (!orgId) {
      res.status(400).json({ error: 'orgId query parameter is required' });
      return;
    }
    // Public teams used to be listed for any org ID, member or not.
    const org = await requireOrgMember(orgId, req.session.userId!);

    const result = await pool.query(
      `SELECT t.*, tm.role as member_role
       FROM teams t
       LEFT JOIN team_members tm ON t.id = tm.team_id AND tm.user_id = $2
       WHERE t.org_id = $1 AND (t.is_private = false OR tm.user_id IS NOT NULL)
       ORDER BY t.name`,
      [org.orgId, req.session.userId],
    );
    res.json({ teams: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list teams');
  }
});

// POST /api/teams - create team (org members only)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { orgId, description, isPrivate } = req.body;

    if (!orgId) throw new AccessError(400, 'orgId and name are required');
    const name = validateName(req.body.name);
    const org = await requireOrgMember(orgId, req.session.userId!);

    const { team, channel } = await withTransaction(async (client) => {
      const teamResult = await client.query(
        `INSERT INTO teams (org_id, name, description, is_private, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [org.orgId, name, description || null, isPrivate === true, req.session.userId],
      );
      const createdTeam = teamResult.rows[0];

      // Add creator as owner
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [createdTeam.id, req.session.userId],
      );

      // Create default "General" channel
      const channelResult = await client.query(
        `INSERT INTO channels (team_id, name, description, created_by)
         VALUES ($1, 'General', 'General discussion', $2) RETURNING *`,
        [createdTeam.id, req.session.userId],
      );

      // Add creator to the default channel
      await client.query(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, [
        channelResult.rows[0].id,
        req.session.userId,
      ]);
      return { team: createdTeam, channel: channelResult.rows[0] };
    });

    res.status(201).json({ team: { ...team, member_role: 'owner' }, defaultChannel: channel });
  } catch (err) {
    respondError(res, err, 'Failed to create team');
  }
});

// GET /api/teams/:teamId - get team details
router.get('/:teamId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireTeam(req.params.teamId, req.session.userId!, 'view');
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [access.teamId]);
    res.json({ team: { ...result.rows[0], member_role: access.teamRole } });
  } catch (err) {
    respondError(res, err, 'Failed to get team');
  }
});

// GET /api/teams/:teamId/members - list team members
router.get('/:teamId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireTeam(req.params.teamId, req.session.userId!, 'view');
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, tm.role, tm.joined_at
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1
       ORDER BY u.display_name`,
      [access.teamId],
    );
    res.json({ members: result.rows });
  } catch (err) {
    respondError(res, err, 'Failed to list team members');
  }
});

// POST /api/teams/:teamId/members - add member to team (or join a public team)
//
// Used to let any signed-in user add anyone — including themselves, as owner —
// to any team in any org. Now: an org member may join a *public* team as a
// plain member; everything else needs a team owner/admin, only owners hand out
// admin/owner, and the target must already belong to the team's organization.
router.post('/:teamId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const actorId = req.session.userId!;
    const access = await requireTeam(req.params.teamId, actorId, 'view');
    const userId = req.body.userId || actorId;
    const role = parseRole(req.body.role);

    const selfJoin = userId === actorId && !access.teamRole;
    if (selfJoin) {
      if (access.isPrivate || role !== 'member') {
        throw new AccessError(403, 'Only team owners and admins can add members');
      }
    } else {
      if (!isManager(access.teamRole)) {
        throw new AccessError(403, 'Only team owners and admins can add members');
      }
      assertCanGrant(access.teamRole, role);
    }

    if (!isUuid(userId)) throw new AccessError(404, 'User not found');
    const inOrg = await pool.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [
      access.orgId,
      userId,
    ]);
    if (inOrg.rows.length === 0) {
      throw new AccessError(400, 'User must be a member of the organization first');
    }

    const added = await addTeamMember(access.teamId, userId, role);
    res.status(added ? 201 : 200).json({ message: added ? 'Member added' : 'Already a member' });
  } catch (err) {
    respondError(res, err, 'Failed to add team member');
  }
});

// PATCH /api/teams/:teamId/members/:userId - change a member's role (owners only)
router.patch('/:teamId/members/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireTeam(req.params.teamId, req.session.userId!, 'member');
    if (!isUuid(req.params.userId)) throw new AccessError(404, 'Member not found');
    if (req.body.role === undefined) throw new AccessError(400, 'role is required');
    const role = parseRole(req.body.role);
    await changeRole('team', access.teamId, req.params.userId, role, req.session.userId!);
    res.json({ message: 'Role updated' });
  } catch (err) {
    respondError(res, err, 'Failed to change team role');
  }
});

// DELETE /api/teams/:teamId/members/:userId - leave (self) or remove a member
router.delete('/:teamId/members/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const access = await requireTeam(req.params.teamId, req.session.userId!, 'view');
    if (!isUuid(req.params.userId)) throw new AccessError(404, 'Member not found');
    const { channelIds } = await removeMember(
      'team',
      access.teamId,
      req.params.userId,
      req.session.userId!,
    );
    // Close the removed user's open channel streams on every instance.
    await evictFromChannels(channelIds, req.params.userId);
    res.json({ message: 'Member removed' });
  } catch (err) {
    respondError(res, err, 'Failed to remove team member');
  }
});

export default router;
