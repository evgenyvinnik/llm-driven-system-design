import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { pool } from './db.js';
import {
  AccessError,
  requireChannel,
  requireMessage,
  requireOrgMember,
  requireTeam,
} from './accessService.js';

const query = vi.mocked(pool.query);
const ID = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-0000000000bb';

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    return (err as AccessError).status;
  }
}

function rows(...r: unknown[]) {
  query.mockResolvedValueOnce({ rows: r } as never);
}

beforeEach(() => query.mockReset());

describe('requireOrgMember', () => {
  it('is 404 for non-members and malformed ids', async () => {
    rows();
    expect(await status(requireOrgMember(ID, USER))).toBe(404);
    expect(await status(requireOrgMember('../etc', USER))).toBe(404);
    expect(query).toHaveBeenCalledTimes(1); // the malformed id never reached Postgres
  });

  it('returns the role for members', async () => {
    rows({ role: 'admin' });
    expect(await requireOrgMember(ID, USER)).toEqual({ orgId: ID, role: 'admin' });
  });
});

describe('requireTeam', () => {
  const team = (isPrivate: boolean, orgRole: string | null, teamRole: string | null) =>
    rows({ id: ID, org_id: 'o', is_private: isPrivate, org_role: orgRole, team_role: teamRole });

  it.each([
    // [private, orgRole, teamRole, need, expected]
    [false, null, null, 'view', 404], // other tenant
    [false, 'member', null, 'view', 200], // public team, same org
    [false, 'member', null, 'member', 403], // can see it, hasn't joined
    [true, 'member', null, 'view', 404], // private team, not on it
    [true, 'member', 'member', 'member', 200],
    [true, 'member', 'member', 'manage', 403],
    [false, 'member', 'admin', 'manage', 200],
    [false, 'member', 'owner', 'manage', 200],
  ] as const)('private=%s org=%s team=%s need=%s -> %i', async (p, o, t, need, expected) => {
    team(p, o, t);
    expect(await status(requireTeam(ID, USER, need))).toBe(expected);
  });
});

describe('requireChannel', () => {
  const channel = (o: string | null, t: string | null, isPrivate: boolean, member: boolean) =>
    rows({
      id: ID,
      team_id: 't',
      org_id: 'o',
      is_private: isPrivate,
      created_by: null,
      org_role: o,
      team_role: t,
      is_channel_member: member,
    });

  it.each([
    // [orgRole, teamRole, private, channelMember, expected]
    [null, null, false, false, 404], // another tenant's channel
    ['member', null, false, false, 404], // public channel, not on the team
    ['member', null, false, true, 404], // stale channel row after leaving the team
    ['member', 'member', false, false, 200], // team membership gates public channels
    ['member', 'member', true, false, 404], // private channel, not a member
    ['member', 'member', true, true, 200],
  ] as const)('org=%s team=%s private=%s member=%s -> %i', async (o, t, p, m, expected) => {
    channel(o, t, p, m);
    expect(await status(requireChannel(ID, USER))).toBe(expected);
  });

  it('is 404 for a channel that does not exist', async () => {
    rows();
    expect(await status(requireChannel(ID, USER))).toBe(404);
  });
});

describe('requireMessage', () => {
  it('hides a message whose channel the caller cannot see', async () => {
    rows({ id: ID, channel_id: ID, user_id: USER, parent_message_id: null, deleted_at: null });
    rows(); // channel access lookup: no row
    const err = await requireMessage(ID, USER).catch((e) => e);
    expect(err).toBeInstanceOf(AccessError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('Message not found');
  });
});
