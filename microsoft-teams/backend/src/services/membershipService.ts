import type pg from 'pg';
import { withTransaction } from './db.js';
import { AccessError, MEMBER_ROLES, type MemberRole } from './accessService.js';

/**
 * Membership changes for organizations and teams.
 *
 * Invariants kept here:
 * - every organization and every team keeps at least one owner (the
 *   "last owner" rule) — leaving, being removed and being demoted all check it;
 * - only owners grant or revoke the owner/admin roles; admins may add and
 *   remove plain members;
 * - leaving a team removes you from all of its channels, and leaving an
 *   organization removes you from all of its teams and channels, so no
 *   membership row outlives the container that grants it.
 *
 * Each change locks the parent row (organization or team) first, so two
 * owners leaving at the same moment are serialized: the second one sees the
 * first one gone and is refused, instead of both passing a "2 owners" check
 * and leaving the team ownerless.
 */
type Scope = 'org' | 'team';

// Table names come from this fixed map, never from request input.
const SCOPES = {
  org: { members: 'org_members', key: 'org_id', parent: 'organizations', label: 'organization' },
  team: { members: 'team_members', key: 'team_id', parent: 'teams', label: 'team' },
} as const;

/** Parses a role from a request body (400 if it isn't one of owner/admin/member). */
export function parseRole(value: unknown, fallback: MemberRole = 'member'): MemberRole {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value)) {
    return value as MemberRole;
  }
  throw new AccessError(400, 'role must be one of owner, admin, member');
}

/** Admins may add plain members; only owners may hand out admin or owner. */
export function assertCanGrant(actorRole: MemberRole | null, role: MemberRole): void {
  if (role === 'member' && (actorRole === 'owner' || actorRole === 'admin')) return;
  if (actorRole === 'owner') return;
  throw new AccessError(
    403,
    role === 'member' ? 'Only owners and admins can add members' : `Only owners can grant the ${role} role`,
  );
}

async function lockParent(client: pg.PoolClient, scope: Scope, parentId: string): Promise<void> {
  const s = SCOPES[scope];
  const result = await client.query(`SELECT id FROM ${s.parent} WHERE id = $1 FOR UPDATE`, [parentId]);
  if (result.rows.length === 0) throw new AccessError(404, `${capitalize(s.label)} not found`);
}

async function roleOf(
  client: pg.PoolClient,
  scope: Scope,
  parentId: string,
  userId: string,
): Promise<MemberRole | null> {
  const s = SCOPES[scope];
  const result = await client.query(
    `SELECT role FROM ${s.members} WHERE ${s.key} = $1 AND user_id = $2`,
    [parentId, userId],
  );
  return result.rows[0]?.role ?? null;
}

async function ownerCount(client: pg.PoolClient, scope: Scope, parentId: string): Promise<number> {
  const s = SCOPES[scope];
  const result = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${s.members} WHERE ${s.key} = $1 AND role = 'owner'`,
    [parentId],
  );
  return result.rows[0].n;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Adds a user to a team and to every public channel in it. Public-channel
 * access is granted by team membership; the channel_members rows are what the
 * member list, presence and unread counts read, so they're materialized here
 * rather than discovered lazily. Returns false if the user was already on the team.
 */
export async function addTeamMember(teamId: string, userId: string, role: MemberRole): Promise<boolean> {
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (team_id, user_id) DO NOTHING RETURNING id`,
      [teamId, userId, role],
    );
    await client.query(
      `INSERT INTO channel_members (channel_id, user_id)
       SELECT id, $2 FROM channels WHERE team_id = $1 AND is_private = false
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [teamId, userId],
    );
    return inserted.rows.length > 0;
  });
}

/** Changes a member's role. Owner-only; refuses to demote the last owner. */
export async function changeRole(
  scope: Scope,
  parentId: string,
  targetUserId: string,
  newRole: MemberRole,
  actorUserId: string,
): Promise<void> {
  const s = SCOPES[scope];
  await withTransaction(async (client) => {
    await lockParent(client, scope, parentId);
    const actorRole = await roleOf(client, scope, parentId, actorUserId);
    if (actorRole !== 'owner') throw new AccessError(403, 'Only owners can change roles');

    const targetRole = await roleOf(client, scope, parentId, targetUserId);
    if (!targetRole) throw new AccessError(404, 'Member not found');

    if (targetRole === 'owner' && newRole !== 'owner' && (await ownerCount(client, scope, parentId)) <= 1) {
      throw new AccessError(409, `A ${s.label} must keep at least one owner; make someone else an owner first`);
    }
    await client.query(`UPDATE ${s.members} SET role = $3 WHERE ${s.key} = $1 AND user_id = $2`, [
      parentId,
      targetUserId,
      newRole,
    ]);
  });
}

/**
 * Removes a member (or lets a member leave). Returns the IDs of every channel
 * the user lost access to, so the caller can evict their live SSE streams.
 */
export async function removeMember(
  scope: Scope,
  parentId: string,
  targetUserId: string,
  actorUserId: string,
): Promise<{ channelIds: string[] }> {
  const s = SCOPES[scope];
  return withTransaction(async (client) => {
    await lockParent(client, scope, parentId);
    const actorRole = await roleOf(client, scope, parentId, actorUserId);
    const targetRole = await roleOf(client, scope, parentId, targetUserId);
    if (!targetRole) throw new AccessError(404, 'Member not found');

    const leaving = actorUserId === targetUserId;
    if (!leaving) {
      const allowed = actorRole === 'owner' || (actorRole === 'admin' && targetRole === 'member');
      if (!allowed) {
        throw new AccessError(
          403,
          actorRole === 'admin'
            ? 'Only owners can remove owners and admins'
            : `Only ${s.label} owners and admins can remove members`,
        );
      }
    }

    if (targetRole === 'owner' && (await ownerCount(client, scope, parentId)) <= 1) {
      throw new AccessError(
        409,
        leaving
          ? `You are the last owner of this ${s.label}; make someone else an owner before leaving`
          : `A ${s.label} must keep at least one owner`,
      );
    }

    let channelIds: string[];
    if (scope === 'team') {
      const channels = await client.query('SELECT id FROM channels WHERE team_id = $1', [parentId]);
      channelIds = channels.rows.map((r: { id: string }) => r.id);
      await client.query('DELETE FROM channel_members WHERE user_id = $1 AND channel_id = ANY($2)', [
        targetUserId,
        channelIds,
      ]);
      await client.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [
        parentId,
        targetUserId,
      ]);
    } else {
      // Lock the org's teams too (org row first, then teams — team-level
      // changes only lock their own team row, so there is no lock cycle) and
      // refuse to strand a team without an owner.
      await client.query('SELECT id FROM teams WHERE org_id = $1 FOR UPDATE', [parentId]);
      const stranded = await client.query(
        `SELECT t.name FROM teams t
         JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2 AND tm.role = 'owner'
         WHERE t.org_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM team_members o
             WHERE o.team_id = t.id AND o.role = 'owner' AND o.user_id <> $2
           )
         ORDER BY t.name`,
        [parentId, targetUserId],
      );
      if (stranded.rows.length > 0) {
        const names = stranded.rows.map((r: { name: string }) => r.name).join(', ');
        throw new AccessError(409, `Last owner of team(s) ${names}; transfer team ownership first`);
      }

      const channels = await client.query(
        'SELECT c.id FROM channels c JOIN teams t ON t.id = c.team_id WHERE t.org_id = $1',
        [parentId],
      );
      channelIds = channels.rows.map((r: { id: string }) => r.id);
      await client.query('DELETE FROM channel_members WHERE user_id = $1 AND channel_id = ANY($2)', [
        targetUserId,
        channelIds,
      ]);
      await client.query(
        'DELETE FROM team_members WHERE user_id = $2 AND team_id IN (SELECT id FROM teams WHERE org_id = $1)',
        [parentId, targetUserId],
      );
      await client.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [
        parentId,
        targetUserId,
      ]);
    }
    return { channelIds };
  });
}
