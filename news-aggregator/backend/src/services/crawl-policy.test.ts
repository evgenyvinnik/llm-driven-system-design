import { describe, it, expect } from 'vitest';
import { classifyStatus, conditionalHeaders, nextCrawlDelaySeconds, parseRetryAfter } from './crawl-policy.js';

const noJitter = () => 0.5; // jitter factor exactly 1.0

describe('conditionalHeaders', () => {
  it('replays stored validators', () => {
    expect(conditionalHeaders({ etag: '"v1"', lastModified: 'Mon, 12 Oct 2026 10:00:00 GMT' })).toEqual({
      'If-None-Match': '"v1"',
      'If-Modified-Since': 'Mon, 12 Oct 2026 10:00:00 GMT',
    });
  });

  it('sends nothing on the first crawl', () => {
    expect(conditionalHeaders({ etag: null, lastModified: null })).toEqual({});
  });
});

describe('classifyStatus', () => {
  it('maps statuses to outcomes', () => {
    expect(classifyStatus(200)).toBe('fetched');
    expect(classifyStatus(304)).toBe('not_modified');
    expect(classifyStatus(404)).toBe('failed');
    expect(classifyStatus(503)).toBe('failed');
  });
});

describe('parseRetryAfter', () => {
  it('parses delay-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-10-14T10:00:00Z');
    expect(parseRetryAfter('Wed, 14 Oct 2026 10:05:00 GMT', now)).toBe(300);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('nextCrawlDelaySeconds', () => {
  const base = { intervalMinutes: 15, maxBackoffMinutes: 1440, random: noJitter };

  it('uses the interval after a fetch or a 304', () => {
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'fetched', consecutiveFailures: 0 })).toBe(900);
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'not_modified', consecutiveFailures: 0 })).toBe(900);
  });

  it('doubles per consecutive failure and caps at the maximum', () => {
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'failed', consecutiveFailures: 1 })).toBe(1800);
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'failed', consecutiveFailures: 3 })).toBe(7200);
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'failed', consecutiveFailures: 12 })).toBe(86400);
  });

  it('never comes back sooner than Retry-After (within the cap)', () => {
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'failed', consecutiveFailures: 1, retryAfterSeconds: 5000 })).toBe(5000);
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'failed', consecutiveFailures: 1, retryAfterSeconds: 10 ** 7 })).toBe(86400);
  });

  it('jitters within +/-10%', () => {
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'fetched', consecutiveFailures: 0, random: () => 0 })).toBe(810);
    expect(nextCrawlDelaySeconds({ ...base, outcome: 'fetched', consecutiveFailures: 0, random: () => 1 })).toBe(990);
  });
});
