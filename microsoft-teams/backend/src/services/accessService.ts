import type { Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Hierarchical authorization: organization > team > channel > message.
 * Every route asks this module whether the caller may act instead of deciding
 * on its own, so the rules live in one place:
 *
 * | Resource        | Visible to                                                     |
 * |-----------------|----------------------------------------------------------------|
 * | organization    | its members                                                    |
 * | public team     | members of the team's organization                             |
 * | private team    | members of the team                                            |
 * | public channel  | members of the channel's team ("team membership gates access") |
 * | private channel | members of the team who are also in channel_members            |
 * | message / file  | whoever can see the channel it belongs to                      |
 *
 * Callers that cannot see a resource get 404, not 403, so IDs from another
 * tenant (or a private team or channel) cannot be probed for existence. 403 is
 * reserved for "you can see this, but you may not change it".
 */
export type MemberRole = 'owner' | 'admin' | 'member';

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];

/** A refusal with its HTTP status; routes turn it into a response. */
export class AccessError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

/**
 * Sends an AccessError as its own status, and anything else as a logged 500
 * with a generic message (internal errors are not echoed to clients).
 */
export function respondError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof AccessError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err }, fallback);
  res.status(500).json({ error: 'Internal server error' });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** IDs are UUIDs; anything else is answered as "not found" before it reaches Postgres (which would 500). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isManager(role: MemberRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface OrgAccess {
  orgId: string;
  role: MemberRole;
}

/** The caller's membership in an organization, or 404 if they are not in it. */
export async function requireOrgMember(orgId: unknown, userId: string): Promise<OrgAccess> {
  if (!isUuid(orgId)) throw new AccessError(404, 'Organization not found');
  const result = await pool.query(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  );
  if (result.rows.length === 0) throw new AccessError(404, 'Organization not found');
  return { orgId, role: result.rows[0].role };
}

export interface TeamAccess {
  teamId: string;
  orgId: string;
  isPrivate: boolean;
  orgRole: MemberRole;
  teamRole: MemberRole | null;
}

/**
 * The caller's access to a team.
 * - `view`: org member, and the team is public or they are on it (else 404)
 * - `member`: on the team (403 if they can see a public team but haven't joined)
 * - `manage`: team owner or admin (403)
 */
export async function requireTeam(
  teamId: unknown,
  userId: string,
  need: 'view' | 'member' | 'manage',
): Promise<TeamAccess> {
  if (!isUuid(teamId)) throw new AccessError(404, 'Team not found');
  const result = await pool.query(
    `SELECT t.id, t.org_id, t.is_private, om.role AS org_role, tm.role AS team_role
     FROM teams t
     LEFT JOIN org_members om ON om.org_id = t.org_id AND om.user_id = $2
     LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $2
     WHERE t.id = $1`,
    [teamId, userId],
  );
  const row = result.rows[0];
  if (!row || !row.org_role || (row.is_private && !row.team_role)) {
    throw new AccessError(404, 'Team not found');
  }
  const access: TeamAccess = {
    teamId: row.id,
    orgId: row.org_id,
    isPrivate: row.is_private,
    orgRole: row.org_role,
    teamRole: row.team_role ?? null,
  };
  if (need === 'member' && !access.teamRole) {
    throw new AccessError(403, 'Join this team to see its channels');
  }
  if (need === 'manage' && !isManager(access.teamRole)) {
    throw new AccessError(403, 'Only team owners and admins can do this');
  }
  return access;
}

export interface ChannelAccess {
  channelId: string;
  teamId: string;
  orgId: string;
  isPrivate: boolean;
  createdBy: string | null;
  teamRole: MemberRole;
  isChannelMember: boolean;
}

/**
 * The caller's access to a channel: org member, team member, and for a private
 * channel also a channel member. Anything less is 404. Every message, thread,
 * reaction, file, presence and SSE request goes through this check.
 */
export async function requireChannel(channelId: unknown, userId: string): Promise<ChannelAccess> {
  if (!isUuid(channelId)) throw new AccessError(404, 'Channel not found');
  const result = await pool.query(
    `SELECT c.id, c.team_id, c.is_private, c.created_by, t.org_id,
            om.role AS org_role, tm.role AS team_role,
            (cm.user_id IS NOT NULL) AS is_channel_member
     FROM channels c
     JOIN teams t ON t.id = c.team_id
     LEFT JOIN org_members om ON om.org_id = t.org_id AND om.user_id = $2
     LEFT JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = $2
     LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
     WHERE c.id = $1`,
    [channelId, userId],
  );
  const row = result.rows[0];
  if (
    !row ||
    !row.org_role ||
    !row.team_role ||
    (row.is_private && !row.is_channel_member)
  ) {
    throw new AccessError(404, 'Channel not found');
  }
  return {
    channelId: row.id,
    teamId: row.team_id,
    orgId: row.org_id,
    isPrivate: row.is_private,
    createdBy: row.created_by,
    teamRole: row.team_role,
    isChannelMember: row.is_channel_member,
  };
}

export interface MessageAccess {
  message: {
    id: string;
    channel_id: string;
    user_id: string;
    parent_message_id: string | null;
    deleted_at: string | null;
  };
  channel: ChannelAccess;
}

/** Loads a message and checks the caller can see its channel (404 otherwise). */
export async function requireMessage(messageId: unknown, userId: string): Promise<MessageAccess> {
  if (!isUuid(messageId)) throw new AccessError(404, 'Message not found');
  const result = await pool.query(
    `SELECT id, channel_id, user_id, parent_message_id, deleted_at
     FROM messages WHERE id = $1`,
    [messageId],
  );
  const message = result.rows[0];
  if (!message) throw new AccessError(404, 'Message not found');
  try {
    const channel = await requireChannel(message.channel_id, userId);
    return { message, channel };
  } catch (err) {
    // Don't reveal that the message exists in a channel the caller can't see.
    if (err instanceof AccessError) throw new AccessError(404, 'Message not found');
    throw err;
  }
}
