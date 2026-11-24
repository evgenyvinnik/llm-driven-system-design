import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  hashUrl,
  extractDomain,
  shouldCrawl,
  resolveUrl,
  calculatePriority,
  isTrackingParam,
} from './url.js';

describe('normalizeUrl', () => {
  it('lowercases scheme and host, strips default port, trailing slash and fragment', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/Path/#frag')).toBe('https://example.com/Path');
  });

  it('keeps non-default ports', () => {
    expect(normalizeUrl('http://example.com:8080/a')).toBe('http://example.com:8080/a');
  });

  it('sorts query parameters', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1')).toBe('https://example.com/p?a=1&b=2');
  });

  it('drops tracking parameters', () => {
    expect(normalizeUrl('https://example.com/p?utm_source=x&id=7&gclid=abc')).toBe(
      'https://example.com/p?id=7'
    );
    expect(normalizeUrl('https://example.com/p?utm_campaign=y')).toBe('https://example.com/p');
  });

  it('makes aliases hash identically', () => {
    expect(hashUrl('https://EXAMPLE.com/a/?utm_medium=z#top')).toBe(hashUrl('https://example.com/a'));
  });
});

describe('isTrackingParam', () => {
  it('matches utm_* and click ids but not content params', () => {
    expect(isTrackingParam('UTM_Source')).toBe(true);
    expect(isTrackingParam('fbclid')).toBe(true);
    expect(isTrackingParam('page')).toBe(false);
  });
});

describe('extractDomain', () => {
  it('includes non-default ports so robots.txt/politeness are per origin', () => {
    expect(extractDomain('http://localhost:8080/x')).toBe('localhost:8080');
    expect(extractDomain('https://WWW.Example.com:443/x')).toBe('www.example.com');
  });

  it('returns empty string for invalid URLs', () => {
    expect(extractDomain('not a url')).toBe('');
  });
});

describe('shouldCrawl', () => {
  it('rejects non-http schemes and binary extensions', () => {
    expect(shouldCrawl('ftp://example.com/a')).toBe(false);
    expect(shouldCrawl('https://example.com/a.pdf')).toBe(false);
    expect(shouldCrawl('https://example.com/a')).toBe(true);
  });
});

describe('resolveUrl', () => {
  it('resolves relative links and ignores javascript/mailto', () => {
    expect(resolveUrl('https://example.com/dir/page', '../other')).toBe('https://example.com/other');
    expect(resolveUrl('https://example.com/', 'mailto:a@b.c')).toBeNull();
    expect(resolveUrl('https://example.com/', 'javascript:void(0)')).toBeNull();
  });
});

describe('calculatePriority', () => {
  it('ranks homepages high and pagination low', () => {
    expect(calculatePriority('https://example.com/', 0, true)).toBe(3);
    expect(calculatePriority('https://example.com/a/b/c/d/page/2', 5)).toBe(1);
  });
});
