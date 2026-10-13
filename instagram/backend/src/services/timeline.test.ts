/**
 * Unit tests for the Redis timeline primitives (services/timeline.ts) against a recording fake
 * pipeline: keyset reads with ties at the cursor's millisecond, the built sentinel, cached-only
 * fan-out writes, and trimming.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    calls: [] as [string, unknown[]][],
    execResult: [] as [Error | null, unknown][],
  };
  const commands = ['zscore', 'zcard', 'zrevrangebyscore', 'zadd', 'expire', 'zremrangebyrank', 'zrem', 'timelineAddIfCached'];
  const makePipeline = () => {
    const pipeline: Record<string, unknown> = {};
    for (const name of commands) {
      pipeline[name] = (...args: unknown[]) => {
        state.calls.push([name, args]);
        return pipeline;
      };
    }
    pipeline.exec = async () => state.execResult;
    return pipeline;
  };
  return { state, makePipeline };
});

vi.mock('./redis.js', () => ({
  default: {
    defineCommand: vi.fn(),
    pipeline: vi.fn(() => fake.makePipeline()),
    zscore: vi.fn(),
    zrem: vi.fn(),
    expire: vi.fn(),
  },
}));

vi.mock('../config/index.js', () => ({
  default: { feed: { timelineMaxEntries: 500, timelineTtlSeconds: 60 } },
}));

vi.mock('./logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  readTimeline,
  addToCachedTimelines,
  mergeIntoTimeline,
  isAfterCursor,
  TIMELINE_BUILT_MEMBER,
  TIMELINE_BUILT_SCORE,
} from './timeline.js';

const USER = '11111111-1111-1111-1111-111111111111';
const KEY = `timeline:${USER}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  fake.state.calls = [];
  fake.state.execResult = [];
});

describe('isAfterCursor', () => {
  it('compares time first, then post id', () => {
    const cursor = { ts: 1000, id: id(5) };
    expect(isAfterCursor({ postId: id(9), score: 999 }, cursor)).toBe(true);
    expect(isAfterCursor({ postId: id(4), score: 1000 }, cursor)).toBe(true);
    expect(isAfterCursor({ postId: id(5), score: 1000 }, cursor)).toBe(false);
    expect(isAfterCursor({ postId: id(1), score: 1001 }, cursor)).toBe(false);
  });
});

describe('readTimeline', () => {
  it('keeps only same-millisecond entries below the cursor id, then older entries', async () => {
    fake.state.execResult = [
      [null, String(TIMELINE_BUILT_SCORE)], // ZSCORE sentinel
      [null, 5], // ZCARD (4 posts + sentinel)
      [null, [id(3), '1000', id(2), '1000', id(1), '1000']], // ties at the cursor's ms
      [null, [id(9), '900']], // strictly older
    ];

    const result = await readTimeline(USER, { ts: 1000, id: id(2) }, 10);

    expect(result.built).toBe(true);
    expect(result.size).toBe(4);
    expect(result.entries).toEqual([
      { postId: id(1), score: 1000 },
      { postId: id(9), score: 900 },
    ]);
    expect(fake.state.calls).toContainEqual(['zrevrangebyscore', [KEY, 1000, 1000, 'WITHSCORES']]);
    expect(fake.state.calls).toContainEqual(['zrevrangebyscore', [KEY, '(1000', '-inf', 'WITHSCORES', 'LIMIT', 0, 10]]);
  });

  it('reads the head below the sentinel and reports an unbuilt timeline', async () => {
    fake.state.execResult = [
      [null, null], // no sentinel: never built (or expired)
      [null, 1],
      [null, [id(5), '500', TIMELINE_BUILT_MEMBER, String(TIMELINE_BUILT_SCORE)]],
    ];

    const result = await readTimeline(USER, null, 5);

    expect(result.built).toBe(false);
    expect(result.size).toBe(1);
    expect(result.entries).toEqual([{ postId: id(5), score: 500 }]);
    expect(fake.state.calls).toContainEqual([
      'zrevrangebyscore',
      [KEY, `(${TIMELINE_BUILT_SCORE}`, '-inf', 'WITHSCORES', 'LIMIT', 0, 5],
    ]);
  });
});

describe('addToCachedTimelines', () => {
  it('writes through the cached-only script and counts timelines actually written', async () => {
    fake.state.execResult = [
      [null, 1],
      [null, 0], // timeline not cached: skipped, its owner rebuilds on read
      [new Error('READONLY'), null],
    ];

    const written = await addToCachedTimelines([id(1), id(2), id(3)], { postId: id(50), score: 1234 });

    expect(written).toBe(1);
    expect(fake.state.calls[0]).toEqual(['timelineAddIfCached', [`timeline:${id(1)}`, 1234, id(50), 501]]);
  });
});

describe('mergeIntoTimeline', () => {
  it('adds entries, trims to the cap plus the sentinel, and refreshes the TTL', async () => {
    fake.state.execResult = [];

    await mergeIntoTimeline(USER, [
      { postId: id(1), score: 100 },
      { postId: id(2), score: 200 },
    ]);

    expect(fake.state.calls).toEqual([
      ['zadd', [KEY, 100, id(1), 200, id(2)]],
      ['zremrangebyrank', [KEY, 0, -502]],
      ['expire', [KEY, 60]],
    ]);
  });
});
