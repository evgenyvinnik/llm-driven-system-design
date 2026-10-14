import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock shared modules before importing the module under test
vi.mock('../db/index.js', () => ({
  queryOne: vi.fn(),
}));
vi.mock('./redis.js', () => ({
  redis: { eval: vi.fn(), zrem: vi.fn() },
}));
vi.mock('./logger.js', () => ({
  streamingLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { queryOne } from '../db/index.js';
import { redis } from './redis.js';
import {
  signStreamToken,
  verifyStreamToken,
  buildStreamUrl,
  qualitiesForPlan,
  evaluateEntitlement,
  acquireStreamSlot,
  resolvePlayable,
  type StreamTokenClaims,
} from './playback.js';

const claims: StreamTokenClaims = {
  sessionId: '11111111-1111-1111-1111-111111111111',
  videoId: 'c0000000-0000-0000-0000-000000000001',
  episodeId: null,
  quality: '720p',
  expiresAt: 2_000_000_000,
};
const now = 1_900_000_000_000;

describe('stream URL tokens', () => {
  it('accepts an untampered token before expiry', () => {
    expect(verifyStreamToken(claims, signStreamToken(claims), now)).toBe('ok');
  });

  it('rejects a token replayed for another quality, title or expiry', () => {
    const sig = signStreamToken(claims);
    expect(verifyStreamToken({ ...claims, quality: '4k' }, sig, now)).toBe('invalid');
    expect(verifyStreamToken({ ...claims, videoId: 'c0000000-0000-0000-0000-000000000002' }, sig, now)).toBe('invalid');
    expect(verifyStreamToken({ ...claims, expiresAt: claims.expiresAt + 3600 }, sig, now)).toBe('invalid');
    expect(verifyStreamToken(claims, 'not-a-signature', now)).toBe('invalid');
  });

  it('rejects a token signed with another secret', () => {
    expect(verifyStreamToken(claims, signStreamToken(claims, 'other-secret'), now)).toBe('invalid');
  });

  it('reports expiry separately from forgery', () => {
    expect(verifyStreamToken(claims, signStreamToken(claims), claims.expiresAt * 1000 + 1)).toBe('expired');
  });

  it('builds a relative /play URL whose query string verifies', () => {
    const url = new URL(buildStreamUrl({ ...claims, episodeId: 'e0000000-0000-0000-0000-000000000003' }), 'http://x');
    expect(url.pathname).toBe(`/api/stream/${claims.videoId}/play`);
    const p = url.searchParams;
    const parsed: StreamTokenClaims = {
      sessionId: p.get('sid')!,
      videoId: claims.videoId,
      episodeId: p.get('episodeId'),
      quality: p.get('quality')!,
      expiresAt: Number(p.get('exp')),
    };
    expect(verifyStreamToken(parsed, p.get('sig')!, now)).toBe('ok');
  });
});

describe('qualitiesForPlan', () => {
  it('caps the ladder by plan', () => {
    expect(qualitiesForPlan('basic').map((q) => q.quality)).toEqual(['240p', '360p', '480p', '720p']);
    expect(qualitiesForPlan('standard').at(-1)?.quality).toBe('1080p');
    expect(qualitiesForPlan('premium').at(-1)?.quality).toBe('4k');
  });

  it('treats an unknown tier as the lowest plan', () => {
    expect(qualitiesForPlan('free-trial').at(-1)?.quality).toBe('720p');
  });

  it('keeps the lowest rendition of a title encoded only above the cap', () => {
    const only4k = [{ quality: '4k', bitrate: 15000, width: 3840, height: 2160 }];
    expect(qualitiesForPlan('basic', only4k)).toEqual(only4k);
  });
});

describe('evaluateEntitlement', () => {
  it('refuses titles above the profile maturity level', () => {
    expect(evaluateEntitlement({ maturityLevel: 1 }, { maturityLevel: 4 })).toEqual({
      allowed: false,
      reason: 'maturity_restricted',
    });
    expect(evaluateEntitlement({ maturityLevel: 4 }, { maturityLevel: 4 })).toEqual({ allowed: true });
  });
});

describe('acquireStreamSlot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the Lua result and passes lease arguments', async () => {
    vi.mocked(redis.eval).mockResolvedValueOnce([0, 2] as never);
    const result = await acquireStreamSlot('acct', 'sess', 2, now, 90);
    expect(result).toEqual({ granted: false, activeStreams: 2, limit: 2 });
    const args = vi.mocked(redis.eval).mock.calls[0];
    expect(args.slice(1)).toEqual([1, 'streams:acct', 'sess', String(now), '90000', '2']);
  });

  it('fails open when Redis is unavailable', async () => {
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await acquireStreamSlot('acct', 'sess', 1, now);
    expect(result.granted).toBe(true);
    expect(result.failedOpen).toBe(true);
  });
});

describe('resolvePlayable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an episode that belongs to another title', async () => {
    vi.mocked(queryOne)
      .mockResolvedValueOnce(null) // episode joined to the requested title
      .mockResolvedValueOnce({ id: claims.videoId }); // the title itself exists
    await expect(resolvePlayable(claims.videoId, 'e0000000-0000-0000-0000-000000000099')).resolves.toBe(
      'episode_not_in_title'
    );
  });

  it('requires an episode for a series', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      id: claims.videoId,
      title: 'Show',
      type: 'series',
      maturity_level: 3,
      duration_minutes: null,
    });
    await expect(resolvePlayable(claims.videoId)).resolves.toBe('episode_required');
  });

  it('resolves an episode to its series with the series maturity level', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({
      video_id: claims.videoId,
      title: 'Show',
      maturity_level: 3,
      episode_id: 'e0000000-0000-0000-0000-000000000003',
      duration_minutes: 55,
    });
    await expect(resolvePlayable(claims.videoId, 'e0000000-0000-0000-0000-000000000003')).resolves.toMatchObject({
      videoId: claims.videoId,
      contentId: 'e0000000-0000-0000-0000-000000000003',
      maturityLevel: 3,
      durationSeconds: 3300,
    });
  });
});
