import { pool } from './db.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for strings PostgreSQL accepts as a UUID; anything else cannot name a row. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

const ORG_MANAGER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** Roles a manager may grant. 'owner' is set only when an org is created. */
export const ASSIGNABLE_ORG_ROLES: ReadonlySet<string> = new Set(['member', 'admin']);
export const ASSIGNABLE_TEAM_ROLES: ReadonlySet<string> = new Set(['member', 'owner']);

/** A user's standing in a team and in the organization that contains it. */
export interface TeamAccess {
  teamId: string;
  orgId: string;
  teamPrivate: boolean;
  /** Role in the organization. Always present: non-members get no access record at all. */
  orgRole: string;
  /** Role in the team, or null when the user is not on the team's roster. */
  teamRole: string | null;
}

/** A user's standing at every level from the organization down to one channel. */
export interface ChannelAccess extends TeamAccess {
  channelId: string;
  channelPrivate: boolean;
  channelMember: boolean;
}

/** Channel access plus the facts about one message that write paths need. */
export interface MessageAccess extends ChannelAccess {
  messageId: string;
  authorId: string;
  parentMessageId: string | null;
  deleted: boolean;
}

// The rules. The organization is the tenant boundary: a user who is not an org member gets no
// access record, so nothing inside the org is reachable. Inside it, `is_private` on a team or a
// channel limits that level to its own roster; public teams and channels are open to the org.

export function canSeeTeam(access: TeamAccess): boolean {
  return !access.teamPrivate || access.teamRole !== null;
}

/** Reading and posting share one rule; private channels require channel membership. */
export function canReadChannel(access: ChannelAccess): boolean {
  return canSeeTeam(access) && (!access.channelPrivate || access.channelMember);
}

export function canManageOrg(orgRole: string | null): boolean {
  return orgRole !== null && ORG_MANAGER_ROLES.has(orgRole);
}

export function canManageTeam(access: TeamAccess): boolean {
  return access.teamRole === 'owner' || canManageOrg(access.orgRole);
}

export function canCreateChannel(access: TeamAccess): boolean {
  return access.teamRole !== null || canManageOrg(access.orgRole);
}

interface AccessRow {
  team_id: string;
  org_id: string;
  team_private: boolean;
  org_role: string;
  team_role: string | null;
  channel_id: string;
  channel_private: boolean;
  channel_member: boolean;
}

// One query walks org -> team -> channel for the requesting user. The inner join on org_members
// is the tenant check: a user outside the organization gets no row, exactly as if the channel
// did not exist.
const CHANNEL_CHAIN = `
  SELECT t.id AS team_id, t.org_id, COALESCE(t.is_private, false) AS team_private,
         COALESCE(om.role, 'member') AS org_role,
         CASE WHEN tm.user_id IS NULL THEN NULL ELSE COALESCE(tm.role, 'member') END AS team_role,
         c.id AS channel_id, COALESCE(c.is_private, false) AS channel_private,
         (cm.user_id IS NOT NULL) AS channel_member
    FROM channels c
    JOIN teams t ON t.id = c.team_id
    JOIN org_members om ON om.org_id = t.org_id AND om.user_id = $2
    LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
    LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2`;

function toChannelAccess(row: AccessRow): ChannelAccess {
  return {
    teamId: row.team_id,
    orgId: row.org_id,
    teamPrivate: row.team_private,
    orgRole: row.org_role,
    teamRole: row.team_role,
    channelId: row.channel_id,
    channelPrivate: row.channel_private,
    channelMember: row.channel_member,
  };
}

/** The user's role in an organization, or null when they are not a member. */
export async function getOrgRole(userId: string, orgId: string): Promise<string | null> {
  if (!isUuid(orgId)) return null;
  const { rows } = await pool.query<{ role: string }>(
    `SELECT COALESCE(role, 'member') AS role FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  return rows[0]?.role ?? null;
}

/** Null when the team does not exist or the user is not in its organization. */
export async function getTeamAccess(userId: string, teamId: string): Promise<TeamAccess | null> {
  if (!isUuid(teamId)) return null;
  const { rows } = await pool.query<Omit<AccessRow, 'channel_id' | 'channel_private' | 'channel_member'>>(
    `SELECT t.id AS team_id, t.org_id, COALESCE(t.is_private, false) AS team_private,
            COALESCE(om.role, 'member') AS org_role,
            CASE WHEN tm.user_id IS NULL THEN NULL ELSE COALESCE(tm.role, 'member') END AS team_role
       FROM teams t
       JOIN org_members om ON om.org_id = t.org_id AND om.user_id = $2
       LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
      WHERE t.id = $1`,
    [teamId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    teamId: row.team_id,
    orgId: row.org_id,
    teamPrivate: row.team_private,
    orgRole: row.org_role,
    teamRole: row.team_role,
  };
}

/** Null when the channel does not exist or the user is not in its organization. */
export async function getChannelAccess(
  userId: string,
  channelId: string,
): Promise<ChannelAccess | null> {
  if (!isUuid(channelId)) return null;
  const { rows } = await pool.query<AccessRow>(`${CHANNEL_CHAIN} WHERE c.id = $1`, [
    channelId,
    userId,
  ]);
  return rows[0] ? toChannelAccess(rows[0]) : null;
}

/** Resolves a message to its channel and the user's access to that channel in one query. */
export async function getMessageAccess(
  userId: string,
  messageId: string,
): Promise<MessageAccess | null> {
  if (!isUuid(messageId)) return null;
  const { rows } = await pool.query<
    AccessRow & { message_id: string; author_id: string; parent_message_id: string | null; deleted: boolean }
  >(
    `SELECT chain.*, m.id AS message_id, m.user_id AS author_id, m.parent_message_id,
            (m.deleted_at IS NOT NULL) AS deleted
       FROM messages m
       JOIN LATERAL (${CHANNEL_CHAIN} WHERE c.id = m.channel_id) chain ON true
      WHERE m.id = $1`,
    [messageId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ...toChannelAccess(row),
    messageId: row.message_id,
    authorId: row.author_id,
    parentMessageId: row.parent_message_id,
    deleted: row.deleted,
  };
}
