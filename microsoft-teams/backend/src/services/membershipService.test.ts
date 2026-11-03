import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A tiny in-memory stand-in for the members tables, enough to exercise the
 * role and last-owner rules without Postgres.
 */
const state = {
  members: new Map<string, string>(), // userId -> role (team_members or org_members)
  strandedTeams: [] as string[], // teams the target is sole owner of (org removal)
  deletedChannelRows: 0,
};

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/FOR UPDATE/.test(sql)) return { rows: [{ id: params[0] }] };
    if (/SELECT role FROM (team|org)_members/.test(sql)) {
      const role = state.members.get(params[1] as string);
      return { rows: role ? [{ role }] : [] };
    }
    if (/COUNT\(\*\)::int AS n/.test(sql)) {
      return { rows: [{ n: [...state.members.values()].filter((r) => r === 'owner').length }] };
    }
    if (/SELECT t\.name FROM teams/.test(sql)) return { rows: state.strandedTeams.map((name) => ({ name })) };
    if (/SELECT (c\.)?id FROM channels/.test(sql)) return { rows: [{ id: 'c1' }, { id: 'c2' }] };
    if (/DELETE FROM channel_members/.test(sql)) {
      state.deletedChannelRows++;
      return { rows: [] };
    }
    if (/DELETE FROM (team|org)_members/.test(sql)) {
      state.members.delete(params[1] as string);
      return { rows: [] };
    }
    if (/UPDATE (team|org)_members SET role/.test(sql)) {
      state.members.set(params[1] as string, params[2] as string);
      return { rows: [] };
    }
    return { rows: [] };
  }),
};

vi.mock('./db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
}));

import { assertCanGrant, changeRole, parseRole, removeMember } from './membershipService.js';
import { AccessError } from './accessService.js';

const TEAM = 'team-1';

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    return (err as AccessError).status;
  }
}

beforeEach(() => {
  state.members = new Map([
    ['owner1', 'owner'],
    ['admin1', 'admin'],
    ['member1', 'member'],
  ]);
  state.strandedTeams = [];
  state.deletedChannelRows = 0;
  client.query.mockClear();
});

describe('roles', () => {
  it('parses only known roles', () => {
    expect(parseRole(undefined)).toBe('member');
    expect(parseRole('admin')).toBe('admin');
    expect(() => parseRole('superuser')).toThrow(AccessError);
  });

  it('lets admins add members but only owners grant admin/owner', () => {
    expect(() => assertCanGrant('admin', 'member')).not.toThrow();
    expect(() => assertCanGrant('admin', 'admin')).toThrow(/Only owners/);
    expect(() => assertCanGrant('admin', 'owner')).toThrow(/Only owners/);
    expect(() => assertCanGrant('member', 'member')).toThrow();
    expect(() => assertCanGrant(null, 'member')).toThrow();
    expect(() => assertCanGrant('owner', 'owner')).not.toThrow();
  });
});

describe('removeMember (team)', () => {
  it('refuses to let the last owner leave', async () => {
    expect(await status(removeMember('team', TEAM, 'owner1', 'owner1'))).toBe(409);
    expect(state.members.get('owner1')).toBe('owner');
  });

  it('lets an owner leave once another owner exists', async () => {
    state.members.set('admin1', 'owner');
    const { channelIds } = await removeMember('team', TEAM, 'owner1', 'owner1');
    expect(state.members.has('owner1')).toBe(false);
    expect(channelIds).toEqual(['c1', 'c2']); // returned so their streams can be evicted
    expect(state.deletedChannelRows).toBe(1); // channel rows removed with the team row
  });

  it('lets anyone leave and admins remove plain members', async () => {
    expect(await status(removeMember('team', TEAM, 'member1', 'member1'))).toBe(200);
    state.members.set('member1', 'member');
    expect(await status(removeMember('team', TEAM, 'member1', 'admin1'))).toBe(200);
  });

  it('does not let admins remove owners or admins, nor members remove anyone', async () => {
    expect(await status(removeMember('team', TEAM, 'owner1', 'admin1'))).toBe(403);
    state.members.set('admin2', 'admin');
    expect(await status(removeMember('team', TEAM, 'admin2', 'admin1'))).toBe(403);
    expect(await status(removeMember('team', TEAM, 'admin1', 'member1'))).toBe(403);
  });

  it('is 404 for someone who is not a member', async () => {
    expect(await status(removeMember('team', TEAM, 'stranger', 'owner1'))).toBe(404);
  });

  it('locks the team row before reading roles', async () => {
    await removeMember('team', TEAM, 'member1', 'member1');
    expect(client.query.mock.calls[0][0]).toMatch(/FROM teams WHERE id = \$1 FOR UPDATE/);
  });
});

describe('removeMember (org)', () => {
  it('refuses to strand a team without an owner', async () => {
    state.strandedTeams = ['Engineering'];
    const err = await removeMember('org', 'org-1', 'member1', 'owner1').catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Engineering/);
    expect(state.members.has('member1')).toBe(true);
  });
});

describe('changeRole', () => {
  it('is owner-only', async () => {
    expect(await status(changeRole('team', TEAM, 'member1', 'admin', 'admin1'))).toBe(403);
    expect(await status(changeRole('team', TEAM, 'member1', 'admin', 'owner1'))).toBe(200);
    expect(state.members.get('member1')).toBe('admin');
  });

  it('refuses to demote the last owner, allows it once there is another', async () => {
    expect(await status(changeRole('team', TEAM, 'owner1', 'member', 'owner1'))).toBe(409);
    await changeRole('team', TEAM, 'admin1', 'owner', 'owner1');
    expect(await status(changeRole('team', TEAM, 'owner1', 'member', 'owner1'))).toBe(200);
  });
});
