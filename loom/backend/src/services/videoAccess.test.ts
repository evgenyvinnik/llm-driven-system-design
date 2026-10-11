import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

vi.mock('./db.js', () => ({ pool: { query: vi.fn() } }));

import { pool } from './db.js';
import { resolveVideoAccess, isUuid } from './videoAccess.js';
import { encodeGrants, SHARE_GRANT_COOKIE } from './shareGrants.js';

const query = pool.query as unknown as ReturnType<typeof vi.fn>;

const OWNER = 'a1111111-1111-1111-1111-111111111111';
const STRANGER = 'a2222222-2222-2222-2222-222222222222';
const VIDEO = '11111111-aaaa-4aaa-8aaa-111111111111';
const SHARE = '50000001-0000-4000-8000-000000000001';

function req(options: { userId?: string; grantFor?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.grantFor) {
    const value = encodeGrants([{ s: SHARE, v: options.grantFor, e: Date.now() + 60_000 }]);
    headers.cookie = `${SHARE_GRANT_COOKIE}=${value}`;
  }
  return { headers, session: options.userId ? { userId: options.userId } : {} } as unknown as Request;
}

describe('resolveVideoAccess', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM videos')) return { rows: [{ id: VIDEO, user_id: OWNER, status: 'ready' }] };
      if (sql.includes('FROM shares')) return { rows: [{ id: SHARE }] };
      return { rows: [] };
    });
  });

  it('treats the uploader as owner without consulting shares', async () => {
    const access = await resolveVideoAccess(req({ userId: OWNER }), VIDEO);
    expect(access?.role).toBe('owner');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('denies a signed-in stranger with no grant (the old IDOR)', async () => {
    expect(await resolveVideoAccess(req({ userId: STRANGER }), VIDEO)).toBeNull();
  });

  it('denies anonymous callers with no grant', async () => {
    expect(await resolveVideoAccess(req(), VIDEO)).toBeNull();
  });

  it('admits a grant holder while the share row is live', async () => {
    const access = await resolveVideoAccess(req({ grantFor: VIDEO }), VIDEO);
    expect(access).toMatchObject({ role: 'viewer', shareId: SHARE });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('expires_at IS NULL OR expires_at > NOW()');
    expect(params).toEqual([[SHARE], VIDEO]);
  });

  it('denies a grant holder once the share is revoked or expired', async () => {
    query.mockImplementation(async (sql: string) =>
      sql.includes('FROM videos') ? { rows: [{ id: VIDEO, user_id: OWNER }] } : { rows: [] },
    );
    expect(await resolveVideoAccess(req({ grantFor: VIDEO }), VIDEO)).toBeNull();
  });

  it('ignores a grant for a different video', async () => {
    const other = '33333333-aaaa-4aaa-8aaa-333333333333';
    expect(await resolveVideoAccess(req({ grantFor: other }), VIDEO)).toBeNull();
  });

  it('rejects malformed ids before touching the database', async () => {
    expect(await resolveVideoAccess(req({ userId: OWNER }), 'not-a-uuid')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(isUuid(VIDEO)).toBe(true);
    expect(isUuid("1' OR '1'='1")).toBe(false);
  });
});
