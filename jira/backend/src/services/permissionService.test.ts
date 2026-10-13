import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, redis, pipelineResult } = vi.hoisted(() => {
  const pipelineResult: { value: [Error | null, string | null][] } = { value: [] };
  const pipeline = {
    get: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => pipelineResult.value),
  };
  return {
    query: vi.fn(),
    pipelineResult,
    redis: {
      pipeline: vi.fn(() => pipeline),
      set: vi.fn().mockResolvedValue('OK'),
      incr: vi.fn().mockResolvedValue(1),
    },
  };
});

vi.mock('../config/database.js', () => ({ query }));
vi.mock('../config/redis.js', () => ({ redis }));
vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn() }) },
}));

import {
  evaluateGrants,
  getProjectPermissions,
  getVisibleProjectIds,
  invalidateProjectPermissions,
  PERMISSIONS,
} from './permissionService.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const developer = { id: 'u-dev', role: 'user' as const };

const defaultScheme = [
  { permission: 'view_issue', grantee_type: 'anyone', grantee_id: null },
  { permission: 'edit_issue', grantee_type: 'role', grantee_id: 'Developer' },
  { permission: 'delete_issue', grantee_type: 'role', grantee_id: 'Administrator' },
  { permission: 'project_admin', grantee_type: 'user', grantee_id: 'u-owner' },
  { permission: 'transition_issue', grantee_type: 'group', grantee_id: 'jira-users' },
];

function mockDatabase(grants = defaultScheme, roles = ['Developer']) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('permission_grants')) return { rows: grants };
    return { rows: roles.map((name) => ({ name })) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineResult.value = [
    [null, null],
    [null, null],
  ];
});

describe('evaluateGrants', () => {
  it('matches anyone, user and role grants and denies by default', () => {
    expect([...evaluateGrants(defaultScheme, { userId: 'u-dev', roles: ['Developer'] })].sort()).toEqual([
      'edit_issue',
      'view_issue',
    ]);
    expect([...evaluateGrants(defaultScheme, { userId: 'u-owner', roles: [] })].sort()).toEqual([
      'project_admin',
      'view_issue',
    ]);
  });

  it('never matches group grants and ignores unknown permissions', () => {
    const held = evaluateGrants(
      [...defaultScheme, { permission: 'launch_rockets', grantee_type: 'anyone', grantee_id: null }],
      { userId: 'u-x', roles: [] }
    );
    expect([...held]).toEqual(['view_issue']);
  });
});

describe('getProjectPermissions', () => {
  it('gives system administrators every permission without touching the database', async () => {
    const held = await getProjectPermissions({ id: 'u-admin', role: 'admin' }, PROJECT);
    expect([...held]).toEqual([...PERMISSIONS]);
    expect(query).not.toHaveBeenCalled();
  });

  it('computes from the database on a miss and caches under the current generation', async () => {
    mockDatabase();
    pipelineResult.value = [
      [null, null],
      [null, '4'],
    ];
    const held = await getProjectPermissions(developer, PROJECT);
    expect([...held].sort()).toEqual(['edit_issue', 'view_issue']);
    expect(redis.set).toHaveBeenCalledWith(
      `jira:perms:${PROJECT}:u-dev`,
      JSON.stringify({ g: '4', p: ['view_issue', 'edit_issue'] }),
      'EX',
      60
    );
  });

  it('serves a cache hit written under the current generation', async () => {
    pipelineResult.value = [
      [null, JSON.stringify({ g: '4', p: ['view_issue'] })],
      [null, '4'],
    ];
    const held = await getProjectPermissions(developer, PROJECT);
    expect([...held]).toEqual(['view_issue']);
    expect(query).not.toHaveBeenCalled();
  });

  it('ignores an entry from an older generation, so revoked access is not served', async () => {
    mockDatabase(defaultScheme, []);
    pipelineResult.value = [
      [null, JSON.stringify({ g: '3', p: ['view_issue', 'edit_issue'] })],
      [null, '4'],
    ];
    const held = await getProjectPermissions(developer, PROJECT);
    expect([...held]).toEqual(['view_issue']);
    expect(query).toHaveBeenCalled();
  });

  it('falls back to the database when Redis fails, without caching', async () => {
    mockDatabase();
    redis.pipeline.mockImplementationOnce(() => {
      throw new Error('redis down');
    });
    const held = await getProjectPermissions(developer, PROJECT);
    expect([...held].sort()).toEqual(['edit_issue', 'view_issue']);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns no permissions for ids that are not UUIDs', async () => {
    expect((await getProjectPermissions(developer, 'DEMO')).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('invalidateProjectPermissions', () => {
  it('bumps the project generation', async () => {
    await invalidateProjectPermissions(PROJECT);
    expect(redis.incr).toHaveBeenCalledWith(`jira:perms-gen:${PROJECT}`);
  });
});

describe('getVisibleProjectIds', () => {
  it('returns null (no filter) for administrators', async () => {
    expect(await getVisibleProjectIds({ id: 'u-admin', role: 'admin' })).toBeNull();
  });

  it('applies the same grant rule per project', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('permission_grants')) {
        return {
          rows: [
            { project_id: PROJECT, permission: 'view_issue', grantee_type: 'role', grantee_id: 'Developer' },
            { project_id: OTHER, permission: 'view_issue', grantee_type: 'role', grantee_id: 'Developer' },
          ],
        };
      }
      return { rows: [{ project_id: PROJECT, name: 'Developer' }] };
    });
    expect(await getVisibleProjectIds(developer)).toEqual([PROJECT]);
  });
});
