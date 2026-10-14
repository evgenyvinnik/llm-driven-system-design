import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory Redis so the real cache helpers run unchanged
const store = new Map<string, string>();
vi.mock('../db/redis.js', () => ({
  redis: {
    get: async (key: string) => store.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => { store.set(key, value); },
    del: async (...keys: string[]) => { keys.forEach(k => store.delete(k)); },
  },
}));

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));

import { decodeCursor, effectiveVelocity, encodeCursor, getPersonalizedFeed, rankStories } from './feed.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600000).toISOString();

function story(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    summary: '',
    primary_topic: 'world',
    topics: ['world'],
    article_count: 2,
    source_count: 2,
    velocity: 0,
    is_breaking: false,
    created_at: hoursAgo(1),
    updated_at: hoursAgo(1),
    last_article_at: hoursAgo(1),
    source_ids: ['src-a'],
    ...overrides,
  } as never;
}

describe('cursor', () => {
  it('round-trips and rejects anything else', () => {
    expect(decodeCursor(encodeCursor({ s: 'snap', o: 20 }))).toEqual({ s: 'snap', o: 20 });
    expect(decodeCursor('20')).toBeNull();
    expect(decodeCursor('%%%')).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});

describe('effectiveVelocity', () => {
  it('decays linearly to zero over the window', () => {
    expect(effectiveVelocity(2, new Date(NOW).toISOString(), NOW, 30)).toBe(2);
    expect(effectiveVelocity(2, new Date(NOW - 15 * 60000).toISOString(), NOW, 30)).toBeCloseTo(1);
    expect(effectiveVelocity(2, hoursAgo(5), NOW, 30)).toBe(0);
  });
});

describe('rankStories', () => {
  const profile = (overrides: Record<string, unknown> = {}) => ({
    user_id: 'u1',
    topic_weights: new Map<string, number>(),
    preferred_sources: [] as string[],
    blocked_sources: [] as string[],
    ...overrides,
  });

  it('drops stories covered only by blocked sources, keeps mixed coverage', () => {
    const ranked = rankStories(
      [story('only-blocked', { source_ids: ['bad'] }), story('mixed', { source_ids: ['bad', 'good'] })],
      profile({ blocked_sources: ['bad'] }),
      NOW
    );
    expect(ranked.map(s => s.id)).toEqual(['mixed']);
  });

  it('boosts stories from preferred sources', () => {
    const ranked = rankStories(
      [story('plain', { source_ids: ['x'] }), story('preferred', { source_ids: ['fav'] })],
      profile({ preferred_sources: ['fav'] }),
      NOW
    );
    expect(ranked[0].id).toBe('preferred');
  });

  it('lets a different topic overtake a run of same-topic stories', () => {
    const ranked = rankStories(
      [
        story('tech-1', { primary_topic: 'technology', source_count: 5 }),
        story('tech-2', { primary_topic: 'technology', source_count: 5 }),
        story('tech-3', { primary_topic: 'technology', source_count: 5 }),
        story('sports', { primary_topic: 'sports', source_count: 4 }),
      ],
      null,
      NOW
    );
    expect(ranked.map(s => s.id).indexOf('sports')).toBe(1);
  });
});

describe('getPersonalizedFeed snapshots', () => {
  let candidates: unknown[];

  beforeEach(() => {
    store.clear();
    query.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('ARRAY(SELECT DISTINCT')) return candidates;
      if (sql.includes('ROW_NUMBER()')) return [];
      if (sql.includes('WHERE id = ANY')) {
        const ids = params[0] as string[];
        return ids.map(id => story(id));
      }
      return []; // topic weights
    });
    queryOne.mockReset().mockResolvedValue(null);
  });

  it('serves later pages from the snapshot even after the ranking changes', async () => {
    candidates = [story('A', { source_count: 5 }), story('B', { source_count: 4 }), story('C', { source_count: 3 })];
    const page1 = await getPersonalizedFeed(null, null, 2);
    expect(page1.stories.map(s => s.id)).toEqual(['A', 'B']);
    expect(page1.has_more).toBe(true);

    // A new top story arrives between page 1 and page 2
    candidates = [story('NEW', { source_count: 5, is_breaking: true }), ...candidates];
    const page2 = await getPersonalizedFeed(null, page1.next_cursor, 2);

    expect(page2.stories.map(s => s.id)).toEqual(['C']);
    expect(page2.has_more).toBe(false);
    const candidateQueries = query.mock.calls.filter(([sql]) => String(sql).includes('ARRAY(SELECT DISTINCT'));
    expect(candidateQueries).toHaveLength(1);
  });

  it('does not serve one viewer\'s snapshot to another', async () => {
    candidates = [story('A'), story('B'), story('C')];
    const page1 = await getPersonalizedFeed('user-1', null, 1);
    await getPersonalizedFeed('user-2', page1.next_cursor, 1);

    const candidateQueries = query.mock.calls.filter(([sql]) => String(sql).includes('ARRAY(SELECT DISTINCT'));
    expect(candidateQueries).toHaveLength(2);
  });
});
