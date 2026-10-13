import { Router, Request, Response } from 'express';
import { pool, withTransaction } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  ASSIGNABLE_TEAM_ROLES,
  canManageTeam,
  canSeeTeam,
  getOrgRole,
  getTeamAccess,
  isUuid,
  type TeamAccess,
} from '../services/access.js';
import { logger } from '../services/logger.js';

const router = Router();

/** The team if the caller can see it; otherwise answers 404 and returns null. */
async function visibleTeam(req: Request, res: Response): Promise<TeamAccess | null> {
  const team = await getTeamAccess(req.session.userId!, req.params.teamId);
  if (!team || !canSeeTeam(team)) {
    res.status(404).json({ error: 'Team not found' });
    return null;
  }
  return team;
}

// GET /api/teams?orgId=xxx - list teams in org (org members only)
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { orgId } = req.query;

    if (!orgId || typeof orgId !== 'string') {
      res.status(400).json({ error: 'orgId query parameter is required' });
      return;
    }

    if (!(await getOrgRole(req.session.userId!, orgId))) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    const result = await pool.query(
      `SELECT t.*, tm.role as member_role
       FROM teams t
       LEFT JOIN team_members tm ON t.id = tm.team_id AND tm.user_id = $2
       WHERE t.org_id = $1 AND (t.is_private = false OR tm.user_id IS NOT NULL)
       ORDER BY t.name`,
      [orgId, req.session.userId],
    );
    res.json({ teams: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list teams');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/teams - create team (org members only)
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { orgId, name, description, isPrivate } = req.body;

    if (!orgId || typeof name !== 'string' || !name.trim() || name.length > 100) {
      res.status(400).json({ error: 'orgId and name (max 100 characters) are required' });
      return;
    }

    if (!(await getOrgRole(req.session.userId!, orgId))) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    const created = await withTransaction(async (client) => {
      const teamResult = await client.query(
        `INSERT INTO teams (org_id, name, description, is_private, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [orgId, name.trim(), description || null, isPrivate === true, req.session.userId],
      );
      const team = teamResult.rows[0];

      // Add creator as owner
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [team.id, req.session.userId],
      );

      // Create default "General" channel
      const channelResult = await client.query(
        `INSERT INTO channels (team_id, name, description, created_by)
         VALUES ($1, 'General', 'General discussion', $2) RETURNING *`,
        [team.id, req.session.userId],
      );
      const channel = channelResult.rows[0];

      // Add creator to the default channel
      await client.query(`INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`, [
        channel.id,
        req.session.userId,
      ]);
      return { team, defaultChannel: channel };
    });

    res.status(201).json(created);
  } catch (err) {
    logger.error({ err }, 'Failed to create team');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/teams/:teamId - get team details
router.get('/:teamId', requireAuth, async (req: Request, res: Response) => {
  try {
    const team = await visibleTeam(req, res);
    if (!team) return;
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [team.teamId]);
    res.json({ team: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'Failed to get team');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/teams/:teamId/members - list team members
router.get('/:teamId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const team = await visibleTeam(req, res);
    if (!team) return;
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, tm.role, tm.joined_at
       FROM team_members tm
       JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = $1
       ORDER BY u.display_name`,
      [team.teamId],
    );
    res.json({ members: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list team members');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/teams/:teamId/members - add an org member to the team (team owners, org owners/admins)
router.post('/:teamId/members', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId, role = 'member' } = req.body;

    if (!isUuid(userId) || !ASSIGNABLE_TEAM_ROLES.has(role)) {
      res.status(400).json({ error: 'userId is required and role must be member or owner' });
      return;
    }

    const team = await visibleTeam(req, res);
    if (!team) return;
    if (!canManageTeam(team)) {
      res.status(403).json({ error: 'Only team owners and organization admins can add members' });
      return;
    }
    if (!(await getOrgRole(userId, team.orgId))) {
      res.status(400).json({ error: 'User must be a member of the organization first' });
      return;
    }

    await pool.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [team.teamId, userId, role],
    );

    res.status(201).json({ message: 'Member added' });
  } catch (err) {
    logger.error({ err }, 'Failed to add team member');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
