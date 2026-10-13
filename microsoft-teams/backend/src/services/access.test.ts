import { describe, expect, it } from 'vitest';
import {
  canCreateChannel,
  canManageOrg,
  canManageTeam,
  canReadChannel,
  canSeeTeam,
  isUuid,
  type ChannelAccess,
} from './access.js';

const base: ChannelAccess = {
  orgId: 'org',
  teamId: 'team',
  channelId: 'channel',
  orgRole: 'member',
  teamRole: null,
  teamPrivate: false,
  channelPrivate: false,
  channelMember: false,
};

describe('hierarchy access rules', () => {
  it('opens public teams and channels to every org member', () => {
    expect(canSeeTeam(base)).toBe(true);
    expect(canReadChannel(base)).toBe(true);
  });

  it('limits a private team to its roster, even for org admins', () => {
    const privateTeam = { ...base, teamPrivate: true };
    expect(canReadChannel(privateTeam)).toBe(false);
    expect(canReadChannel({ ...privateTeam, orgRole: 'owner' })).toBe(false);
    expect(canReadChannel({ ...privateTeam, teamRole: 'member' })).toBe(true);
  });

  it('limits a private channel to its own members, not the whole team', () => {
    const privateChannel = { ...base, channelPrivate: true, teamRole: 'owner' };
    expect(canReadChannel(privateChannel)).toBe(false);
    expect(canReadChannel({ ...privateChannel, channelMember: true })).toBe(true);
  });

  it('lets team owners and org managers add team members, not plain members', () => {
    expect(canManageTeam({ ...base, teamRole: 'owner' })).toBe(true);
    expect(canManageTeam({ ...base, orgRole: 'admin' })).toBe(true);
    expect(canManageTeam({ ...base, teamRole: 'member' })).toBe(false);
  });

  it('lets team members (or org managers) create channels', () => {
    expect(canCreateChannel({ ...base, teamRole: 'member' })).toBe(true);
    expect(canCreateChannel({ ...base, orgRole: 'owner' })).toBe(true);
    expect(canCreateChannel(base)).toBe(false);
  });

  it('lets only owners and admins manage an organization', () => {
    expect(canManageOrg('owner')).toBe(true);
    expect(canManageOrg('admin')).toBe(true);
    expect(canManageOrg('member')).toBe(false);
    expect(canManageOrg(null)).toBe(false);
  });

  it('accepts only well-formed UUIDs as ids', () => {
    expect(isUuid('cccccccc-0000-0000-0000-000000000001')).toBe(true);
    expect(isUuid("1' OR '1'='1")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
