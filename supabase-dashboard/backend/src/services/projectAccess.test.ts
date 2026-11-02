import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

vi.mock('./db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { pool } from './db.js';
import { requireProject, type ProjectNeed } from './projectAccess.js';
import { encryptSecret } from './credentials.js';
import { ApiError } from './errors.js';

const query = vi.mocked(pool.query);
const PROJECT = '9a000001-0000-0000-0000-000000000001';
const ALICE = 'a1111111-1111-1111-1111-111111111111';
const BOB = 'b2222222-2222-2222-2222-222222222222';

function req(userId: string | undefined, projectId = PROJECT): Request {
  return { params: { projectId }, session: { userId } } as unknown as Request;
}

/** Mocks the project+membership lookup. */
function project(createdBy: string, memberRole: string | null) {
  query.mockResolvedValueOnce({
    rows: [
      {
        id: PROJECT,
        created_by: createdBy,
        db_host: 'localhost',
        db_port: 5433,
        db_name: 'sample_db',
        db_user: 'sample',
        db_password: encryptSecret('sample123'),
        member_role: memberRole,
      },
    ],
  } as never);
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    return (err as ApiError).status;
  }
}

beforeEach(() => query.mockReset());

describe('project roles', () => {
  it.each([
    // [created by, caller's member role, need, expected]
    [ALICE, null, 'own', 200], // the creator is the owner even without a member row
    [ALICE, 'viewer', 'own', 200], // ...and a stray member row can't demote them
    [BOB, 'owner', 'own', 200],
    [BOB, 'editor', 'edit', 200],
    [BOB, 'editor', 'own', 403],
    [BOB, 'viewer', 'view', 200],
    [BOB, 'viewer', 'edit', 403],
    [BOB, null, 'view', 404], // not a member: invisible, not forbidden
    [BOB, 'superuser', 'view', 404], // unknown role strings grant nothing
  ] as const)('creator=%s role=%s need=%s → %s', async (createdBy, role, need, expected) => {
    project(createdBy, role);
    expect(await status(requireProject(req(ALICE), need as ProjectNeed))).toBe(expected);
  });

  it('treats a missing project as 404', async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);
    expect(await status(requireProject(req(ALICE), 'view'))).toBe(404);
  });

  it('answers malformed ids and anonymous callers without touching the database', async () => {
    expect(await status(requireProject(req(ALICE, 'not-a-uuid'), 'view'))).toBe(404);
    expect(await status(requireProject(req(undefined), 'view'))).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('decrypts the connection only when asked', async () => {
    project(ALICE, null);
    const access = await requireProject(req(ALICE), 'view');
    expect(access.connection()).toEqual({
      host: 'localhost',
      port: 5433,
      database: 'sample_db',
      user: 'sample',
      password: 'sample123',
    });
  });
});
