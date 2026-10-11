import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  encodeGrants,
  decodeGrants,
  issueGrant,
  grantedShareIds,
  SHARE_GRANT_COOKIE,
  type ShareGrant,
} from './shareGrants.js';

const SHARE = '50000001-0000-4000-8000-000000000001';
const VIDEO = '11111111-aaaa-4aaa-8aaa-111111111111';
const OTHER_VIDEO = '33333333-aaaa-4aaa-8aaa-333333333333';

function requestWith(cookieValue?: string): Request {
  return {
    headers: cookieValue ? { cookie: `other=1; ${SHARE_GRANT_COOKIE}=${cookieValue}` } : {},
  } as unknown as Request;
}

describe('share grant cookie', () => {
  it('round-trips signed grants and drops expired ones', () => {
    const now = Date.now();
    const grants: ShareGrant[] = [
      { s: SHARE, v: VIDEO, e: now + 60_000 },
      { s: 'expired', v: VIDEO, e: now - 1 },
    ];
    expect(decodeGrants(encodeGrants(grants), now)).toEqual([grants[0]]);
  });

  it('rejects a tampered payload', () => {
    const value = encodeGrants([{ s: SHARE, v: VIDEO, e: Date.now() + 60_000 }]);
    const [, signature] = value.split('.');
    const forged = Buffer.from(JSON.stringify([{ s: SHARE, v: OTHER_VIDEO, e: Date.now() + 60_000 }])).toString(
      'base64url',
    );
    expect(decodeGrants(`${forged}.${signature}`)).toEqual([]);
    expect(decodeGrants('not-a-cookie')).toEqual([]);
    expect(decodeGrants(undefined)).toEqual([]);
  });

  it('only returns share ids granted for the requested video', () => {
    const value = encodeGrants([
      { s: SHARE, v: VIDEO, e: Date.now() + 60_000 },
      { s: 'other-share', v: OTHER_VIDEO, e: Date.now() + 60_000 },
    ]);
    expect(grantedShareIds(requestWith(value), VIDEO)).toEqual([SHARE]);
    expect(grantedShareIds(requestWith(), VIDEO)).toEqual([]);
  });

  it('never lets a grant outlive the share it came from', () => {
    const now = Date.now();
    const shareExpiry = new Date(now + 5 * 60_000);
    const cookie = vi.fn();
    issueGrant(requestWith(), { cookie } as unknown as Response, {
      id: SHARE,
      videoId: VIDEO,
      expiresAt: shareExpiry,
    }, now);

    const [name, value, options] = cookie.mock.calls[0];
    expect(name).toBe(SHARE_GRANT_COOKIE);
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api' });
    expect(decodeGrants(value, now)).toEqual([{ s: SHARE, v: VIDEO, e: shareExpiry.getTime() }]);
  });

  it('refreshes an existing grant instead of duplicating it', () => {
    const now = Date.now();
    const existing = encodeGrants([{ s: SHARE, v: VIDEO, e: now + 1000 }]);
    const cookie = vi.fn();
    issueGrant(requestWith(existing), { cookie } as unknown as Response, {
      id: SHARE,
      videoId: VIDEO,
      expiresAt: null,
    }, now);
    const grants = decodeGrants(cookie.mock.calls[0][1], now);
    expect(grants).toHaveLength(1);
    expect(grants[0].e).toBeGreaterThan(now + 1000);
  });
});
