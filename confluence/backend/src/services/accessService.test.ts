import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('./logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { pool } from './db.js';
import { AccessError, canSeePage, requirePage, requireSpace } from './accessService.js';

const query = vi.mocked(pool.query);
const SPACE = '00000000-0000-4000-8000-0000000000aa';
const PAGE = '00000000-0000-4000-8000-0000000000bb';

/** Mocks the space lookup, then the membership lookup. */
function space(isPublic: boolean, role: string | null) {
  query.mockResolvedValueOnce({ rows: [{ id: SPACE, key: 'ENG', is_public: isPublic }] } as never);
  query.mockResolvedValueOnce({ rows: role ? [{ role }] : [] } as never);
}

/** Mocks the page+space lookup, then the membership lookup. */
function page(status: string, isPublic: boolean, role: string | null) {
  query.mockResolvedValueOnce({
    rows: [{ id: PAGE, space_id: SPACE, parent_id: null, status, version: 3, space_key: 'ENG', is_public: isPublic }],
  } as never);
  query.mockResolvedValueOnce({ rows: role ? [{ role }] : [] } as never);
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    return (err as AccessError).status;
  }
}

beforeEach(() => query.mockReset());

describe('space roles', () => {
  const user = { userId: 'u1' };

  it.each([
    // [public, role, need, expected status]
    [true, null, 'view', 200],
    [false, null, 'view', 404],
    [false, 'viewer', 'view', 200],
    [true, 'viewer', 'edit', 403],
    [true, 'member', 'edit', 200],
    [true, 'member', 'admin', 403],
    [false, 'admin', 'admin', 200],
  ] as const)('public=%s role=%s need=%s → %s', async (isPublic, role, need, expected) => {
    space(isPublic, role);
    expect(await status(requireSpace({ key: 'ENG' }, user, need))).toBe(expected);
  });

  it('asks anonymous callers to sign in rather than refusing outright', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: SPACE, key: 'ENG', is_public: true }] } as never);
    expect(await status(requireSpace({ key: 'ENG' }, {}, 'edit'))).toBe(401);
  });

  it('treats a global admin as admin of every space without a membership row', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: SPACE, key: 'SEC', is_public: false }] } as never);
    const access = await requireSpace({ key: 'SEC' }, { userId: 'root', globalRole: 'admin' }, 'admin');
    expect(access.canAdmin).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('drafts', () => {
  it('are hidden from viewers as if they did not exist', async () => {
    page('draft', true, 'viewer');
    expect(await status(requirePage(PAGE, { userId: 'u1' }, 'view'))).toBe(404);
  });

  it('are visible to members', async () => {
    page('draft', true, 'member');
    const { access } = await requirePage(PAGE, { userId: 'u1' }, 'view');
    expect(access.canEdit).toBe(true);
  });

  it('canSeePage only shows published pages to non-editors', () => {
    const viewer = { canView: true, canEdit: false } as Parameters<typeof canSeePage>[1];
    expect(canSeePage({ status: 'published' }, viewer)).toBe(true);
    expect(canSeePage({ status: 'archived' }, viewer)).toBe(false);
  });
});
