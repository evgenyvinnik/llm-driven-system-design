/**
 * Unit tests for the hybrid fan-out feed (services/feedService.ts).
 * PostgreSQL and the Redis timeline module are mocked; the algorithm runs for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: {
    feed: {
      celebrityFollowerThreshold: 3,
      timelineMaxEntries: 4,
      timelineTtlSeconds: 60,
      fanoutBatchSize: 2,
      followBackfillCount: 10,
    },
  },
}));

vi.mock('./db.js', () => ({ query: vi.fn() }));

vi.mock('./timeline.js', () => ({
  readTimeline: vi.fn(),
  isTimelineBuilt: vi.fn(),
  markTimelineBuilt: vi.fn().mockResolvedValue(undefined),
  unmarkTimelineBuilt: vi.fn().mockResolvedValue(undefined),
  mergeIntoTimeline: vi.fn().mockResolvedValue(undefined),
  touchTimeline: vi.fn().mockResolvedValue(undefined),
  addToCachedTimelines: vi.fn(),
  removeFromTimelines: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./metrics.js', () => {
  const counter = { inc: vi.fn(), labels: vi.fn().mockReturnValue({ inc: vi.fn() }) };
  return { feedFanoutTotal: counter, feedFanoutTimelineWrites: counter };
});

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { query } from './db.js';
import {
  readTimeline,
  markTimelineBuilt,
  unmarkTimelineBuilt,
  mergeIntoTimeline,
  addToCachedTimelines,
} from './timeline.js';
import {
  encodeFeedCursor,
  decodeFeedCursor,
  mergeCandidates,
  getFeedPage,
  fanOutPost,
  rebuildTimeline,
} from './feedService.js';

const VIEWER = '11111111-1111-1111-1111-111111111111';
const AUTHOR = '22222222-2222-2222-2222-222222222222';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length }) as never;
const sqlOf = (call: unknown[]) => String(call[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query).mockReset();
  vi.mocked(readTimeline).mockReset();
  vi.mocked(addToCachedTimelines).mockReset();
});

describe('feed cursor', () => {
  it('round-trips created_ms and post id', () => {
    const cursor = encodeFeedCursor({ postId: id(7), score: 1717171717171 });
    expect(cursor).toBe(`1717171717171_${id(7)}`);
    expect(decodeFeedCursor(cursor)).toEqual({ ts: 1717171717171, id: id(7) });
  });

  it('rejects offsets and malformed values', () => {
    expect(decodeFeedCursor('20')).toBeNull();
    expect(decodeFeedCursor('abc_' + id(1))).toBeNull();
    expect(decodeFeedCursor('123_not-a-uuid')).toBeNull();
    expect(decodeFeedCursor('-5_' + id(1))).toBeNull();
  });
});

describe('mergeCandidates', () => {
  it('orders by time then id (both descending) and drops duplicates', () => {
    const merged = mergeCandidates(
      [
        { postId: id(1), score: 100 },
        { postId: id(3), score: 300 },
      ],
      [
        { postId: id(2), score: 300 },
        { postId: id(1), score: 100 },
      ]
    );
    expect(merged.map((e) => e.postId)).toEqual([id(3), id(2), id(1)]);
  });
});

describe('getFeedPage', () => {
  it('merges pushed and pulled posts, hydrates only the page, and sets the next cursor', async () => {
    vi.mocked(readTimeline).mockResolvedValueOnce({
      built: true,
      size: 2,
      entries: [
        { postId: id(1), score: 500 },
        { postId: id(2), score: 300 },
      ],
    });
    vi.mocked(query)
      .mockResolvedValueOnce(rows([{ id: id(9), created_ms: '400' }])) // celebrity pull
      .mockResolvedValueOnce(rows([])); // hydration (content irrelevant here)

    const page = await getFeedPage(VIEWER, null, 2);

    expect(page.nextCursor).toBe(`400_${id(9)}`);
    expect(page.pushedCount).toBe(1);
    expect(page.pulledCount).toBe(1);
    const hydration = vi.mocked(query).mock.calls.find((call) => sqlOf(call).includes('json_agg'));
    expect(hydration?.[1]).toEqual([[id(1), id(9)], VIEWER]);
  });

  it('reports no next page when every source is exhausted', async () => {
    vi.mocked(readTimeline).mockResolvedValueOnce({ built: true, size: 1, entries: [{ postId: id(1), score: 500 }] });
    vi.mocked(query).mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([]));

    const page = await getFeedPage(VIEWER, null, 20);

    expect(page.nextCursor).toBeNull();
  });

  it('rebuilds a missing timeline, marking it built before reading PostgreSQL', async () => {
    vi.mocked(readTimeline)
      .mockResolvedValueOnce({ built: false, size: 0, entries: [] })
      .mockResolvedValueOnce({ built: true, size: 1, entries: [{ postId: id(1), score: 500 }] });
    vi.mocked(query)
      .mockResolvedValueOnce(rows([])) // celebrity pull
      .mockResolvedValueOnce(rows([{ id: id(1), created_ms: '500' }])) // rebuild source
      .mockResolvedValueOnce(rows([])); // hydration

    const page = await getFeedPage(VIEWER, null, 20);

    expect(page.timelineRebuilt).toBe(true);
    expect(mergeIntoTimeline).toHaveBeenCalledWith(VIEWER, [{ postId: id(1), score: 500 }]);
    const markOrder = vi.mocked(markTimelineBuilt).mock.invocationCallOrder[0];
    const rebuildQuery = vi.mocked(query).mock.calls.findIndex((call) => sqlOf(call).includes('fu.follower_count <'));
    expect(markOrder).toBeLessThan(vi.mocked(query).mock.invocationCallOrder[rebuildQuery]);
  });

  it('continues from PostgreSQL with the same cursor once the capped timeline runs out', async () => {
    vi.mocked(readTimeline).mockResolvedValueOnce({
      built: true,
      size: 4, // == timelineMaxEntries: older entries may have been trimmed
      entries: [{ postId: id(4), score: 200 }],
    });
    vi.mocked(query)
      .mockResolvedValueOnce(rows([])) // celebrity pull
      .mockResolvedValueOnce(rows([{ id: id(5), created_ms: '150' }])) // continuation
      .mockResolvedValueOnce(rows([])); // hydration

    await getFeedPage(VIEWER, { ts: 250, id: id(8) }, 3);

    const continuation = vi.mocked(query).mock.calls[1];
    expect(sqlOf(continuation)).toContain('fu.follower_count <');
    expect(continuation[1]).toEqual([VIEWER, 3, 200, id(4), 3]); // continues after the last timeline entry
    const hydration = vi.mocked(query).mock.calls[2];
    expect(hydration[1]).toEqual([[id(4), id(5)], VIEWER]);
  });
});

describe('fanOutPost', () => {
  it('pushes to followers in keyset-paged batches for a regular author', async () => {
    vi.mocked(addToCachedTimelines).mockImplementation(async (ids: string[]) => ids.length);
    vi.mocked(query)
      .mockResolvedValueOnce(rows([{ follower_count: 2 }])) // below threshold (3)
      .mockResolvedValueOnce(rows([{ follower_id: id(1) }, { follower_id: id(2) }])) // batch 1 (full)
      .mockResolvedValueOnce(rows([{ follower_id: id(3) }])); // batch 2 (short -> stop)

    const result = await fanOutPost(AUTHOR, id(50), 1000);

    expect(result).toEqual({ mode: 'push', followerCount: 2, timelinesWritten: 4 });
    expect(vi.mocked(addToCachedTimelines).mock.calls.map(([ids]) => ids)).toEqual([[AUTHOR], [id(1), id(2)], [id(3)]]);
    const secondPage = vi.mocked(query).mock.calls[2];
    expect(sqlOf(secondPage)).toContain('follower_id > $2');
    expect(secondPage[1]).toEqual([AUTHOR, id(2), 2]);
  });

  it('skips follower fan-out entirely for a celebrity author', async () => {
    vi.mocked(addToCachedTimelines).mockResolvedValue(1);
    vi.mocked(query).mockResolvedValueOnce(rows([{ follower_count: 3 }])); // at threshold

    const result = await fanOutPost(AUTHOR, id(50), 1000);

    expect(result.mode).toBe('pull');
    expect(addToCachedTimelines).toHaveBeenCalledTimes(1);
    expect(addToCachedTimelines).toHaveBeenCalledWith([AUTHOR], { postId: id(50), score: 1000 });
    expect(query).toHaveBeenCalledTimes(1); // no follower scan
  });
});

describe('rebuildTimeline', () => {
  it('removes the built marker when the rebuild fails, so the next read tries again', async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error('db down'));

    await expect(rebuildTimeline(VIEWER)).rejects.toThrow('db down');

    expect(markTimelineBuilt).toHaveBeenCalledWith(VIEWER);
    expect(unmarkTimelineBuilt).toHaveBeenCalledWith(VIEWER);
  });
});
