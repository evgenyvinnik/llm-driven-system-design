import { describe, it, expect, vi } from 'vitest';

// Mock infrastructure modules before importing the crawler
vi.mock('../models/database.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../models/redis.js', () => ({
  redis: {},
  REDIS_KEYS: {},
  PRIORITY_QUEUES: [],
  queueKeyForPriority: () => 'q',
}));

import * as cheerio from 'cheerio';
import { extractLinks, parseRetryAfter } from './crawler.js';
import { config } from '../config.js';

const PAGE = 'https://example.com/dir/page';

describe('extractLinks', () => {
  it('resolves, normalizes and de-duplicates links', () => {
    const $ = cheerio.load(`
      <a href="/a">A</a>
      <a href="/a/">A again</a>
      <a href="https://EXAMPLE.com/a#x">A third time</a>
      <a href="sibling">Relative</a>
      <a href="mailto:x@y.z">Mail</a>
      <a href="/logo.png">Image</a>
    `);
    expect(extractLinks($, PAGE).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/dir/sibling',
    ]);
  });

  it('honors <base href> for relative links', () => {
    const $ = cheerio.load(`
      <head><base href="https://cdn.example.org/root/"></head>
      <a href="child">Child</a>
    `);
    expect(extractLinks($, PAGE)).toEqual(['https://cdn.example.org/root/child']);
  });

  it('skips rel=nofollow/sponsored/ugc links', () => {
    const $ = cheerio.load(`
      <a href="/keep">Keep</a>
      <a href="/ad" rel="sponsored noopener">Ad</a>
      <a href="/comment" rel="UGC">Comment</a>
      <a href="/no" rel="nofollow">No</a>
    `);
    expect(extractLinks($, PAGE)).toEqual(['https://example.com/keep']);
  });

  it('returns nothing when meta robots says nofollow', () => {
    const $ = cheerio.load(`
      <head><meta name="ROBOTS" content="noindex, NoFollow"></head>
      <a href="/a">A</a>
    `);
    expect(extractLinks($, PAGE)).toEqual([]);
  });

  it('does not return a self-link', () => {
    const $ = cheerio.load(`<a href="${PAGE}/">Self</a><a href="/x">X</a>`);
    expect(extractLinks($, PAGE)).toEqual(['https://example.com/x']);
  });

  it('caps links per page', () => {
    const many = Array.from({ length: config.crawler.maxLinksPerPage + 50 }, (_, i) => `<a href="/p${i}">p</a>`).join('');
    expect(extractLinks(cheerio.load(many), PAGE)).toHaveLength(config.crawler.maxLinksPerPage);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120000);
  });

  it('parses HTTP-dates', () => {
    const inTenSeconds = new Date(Date.now() + 10000).toUTCString();
    const ms = parseRetryAfter(inTenSeconds)!;
    expect(ms).toBeGreaterThan(8000);
    expect(ms).toBeLessThanOrEqual(10000);
  });

  it('caps at one hour and ignores garbage', () => {
    expect(parseRetryAfter('999999')).toBe(3600000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
