import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock shared modules before importing the crawler
const query = vi.fn();
const queryOne = vi.fn();
const clientQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  withTransaction: async (fn: (client: { query: typeof clientQuery }) => unknown) => fn({ query: clientQuery }),
}));
vi.mock('../db/elasticsearch.js', () => ({ indexArticle: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../shared/cache.js', () => ({ invalidateGlobalCaches: vi.fn().mockResolvedValue(undefined) }));

import { bandLockKeys, closestStory, crawlSource, fetchFeed, normalizeArticleUrl, type ClaimedSource } from './crawler.js';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
  <item><title>Rates rise again</title><link>https://example.com/a</link><description>The central bank raised rates.</description></item>
  <item><title>Sneaky</title><link>javascript:alert(1)</link><description>should be skipped</description></item>
</channel></rss>`;

let sourceCounter = 0;
function claimed(overrides: Partial<ClaimedSource> = {}): ClaimedSource {
  sourceCounter++;
  return {
    id: `source-${sourceCounter}`,
    name: `Source ${sourceCounter}`,
    domain: `feed${sourceCounter}.test`,
    feed_url: `https://feed${sourceCounter}.test/rss`,
    category: 'world',
    crawl_frequency_minutes: 15,
    etag: null,
    last_modified: null,
    consecutive_failures: 0,
    lease_token: 'lease-1',
    ...overrides,
  };
}

/** Parameters passed to the completeCrawl UPDATE (the only top-level query). */
function completion() {
  const [, params] = query.mock.calls.at(-1) as [string, unknown[]];
  return {
    delaySeconds: params[2] as number,
    etag: params[3],
    lastModified: params[4],
    failures: params[5],
    status: params[6],
    error: params[7],
    success: params[8],
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  query.mockReset().mockResolvedValue([{ source_id: 'x' }]);
  queryOne.mockReset();
  clientQuery.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO articles')) return { rowCount: 1, rows: [{ id: 'article-1' }] };
    if (sql.includes('INSERT INTO stories')) return { rowCount: 1, rows: [{ id: 'story-1' }] };
    return { rowCount: 0, rows: [] };
  });
});

describe('fetchFeed', () => {
  it('sends conditional headers and reports a 304 as not modified', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304, headers: { ETag: '"v2"' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchFeed(claimed({ etag: '"v1"', last_modified: 'Mon, 12 Oct 2026 10:00:00 GMT' }));

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['If-None-Match']).toBe('"v1"');
    expect(headers['If-Modified-Since']).toBe('Mon, 12 Oct 2026 10:00:00 GMT');
    expect(result).toMatchObject({ kind: 'not_modified', status: 304, etag: '"v2"' });
  });

  it('turns a 503 with Retry-After into a failure carrying the delay', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503, headers: { 'Retry-After': '7200' } })));
    const result = await fetchFeed(claimed());
    expect(result).toMatchObject({ kind: 'failed', status: 503, retryAfterSeconds: 7200 });
  });

  it('reports network errors without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await fetchFeed(claimed());
    expect(result).toMatchObject({ kind: 'failed', status: null, error: 'ECONNREFUSED' });
  });
});

describe('crawlSource', () => {
  it('ingests http(s) items, skips other schemes, and stores the new validators', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(RSS, {
      status: 200,
      headers: { ETag: '"v9"', 'Last-Modified': 'Tue, 13 Oct 2026 08:00:00 GMT' },
    })));

    const result = await crawlSource(claimed({ etag: '"v1"', consecutive_failures: 2 }));

    expect(result).toMatchObject({ outcome: 'fetched', articles_found: 2, articles_new: 1 });
    const insertedUrls = clientQuery.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO articles'))
      .map(([, params]) => (params as unknown[])[2]);
    expect(insertedUrls).toEqual(['https://example.com/a']);
    // Clustering takes the four band locks before looking for candidates
    expect(clientQuery.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_xact_lock'))).toHaveLength(4);
    expect(completion()).toMatchObject({ etag: '"v9"', lastModified: 'Tue, 13 Oct 2026 08:00:00 GMT', failures: 0, success: true });
  });

  it('keeps the old validators when an item failed, so the next fetch retries it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(RSS, { status: 200, headers: { ETag: '"v9"' } })));
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO articles')) throw new Error('connection reset');
      return { rowCount: 0, rows: [] };
    });

    const result = await crawlSource(claimed({ etag: '"v1"' }));

    expect(result.errors).toHaveLength(1);
    expect(completion()).toMatchObject({ etag: '"v1"', failures: 0, success: true });
  });

  it('backs off after a failure, honors Retry-After and keeps old validators', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503, headers: { 'Retry-After': '7200' } })));

    const result = await crawlSource(claimed({ etag: '"v1"', consecutive_failures: 2 }));

    expect(result.outcome).toBe('failed');
    const done = completion();
    expect(done).toMatchObject({ etag: '"v1"', failures: 3, status: 503, success: false });
    expect(done.delaySeconds).toBeGreaterThanOrEqual(7200);
  });

  it('reports a lost lease instead of a next crawl time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 304 })));
    query.mockResolvedValue([]); // fencing token no longer matches

    const result = await crawlSource(claimed({ etag: '"v1"' }));

    expect(result.outcome).toBe('not_modified');
    expect(result.next_crawl_in_seconds).toBeNull();
  });
});

describe('clustering helpers', () => {
  it('picks the closest candidate under the threshold', () => {
    const fp = 0b1111n;
    const match = closestStory(fp, [
      { id: 'far', fingerprint: (fp ^ 0b111n).toString() }, // distance 3: not a match
      { id: 'near', fingerprint: (fp ^ 0b1n).toString() }, // distance 1
      { id: 'mid', fingerprint: (fp ^ 0b11n).toString() }, // distance 2
    ]);
    expect(match).toEqual({ id: 'near', distance: 1 });
    expect(closestStory(fp, [{ id: 'far', fingerprint: (fp ^ 0b111n).toString() }])).toBeNull();
  });

  it('builds ascending, band-specific advisory lock keys', () => {
    expect(bandLockKeys([65535, 0, 7, 7])).toEqual([65535, 65536, 131079, 196615]);
  });

  it('only accepts absolute http(s) article links', () => {
    expect(normalizeArticleUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1');
    expect(normalizeArticleUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeArticleUrl('/relative/path')).toBeNull();
    expect(normalizeArticleUrl(undefined)).toBeNull();
  });
});
