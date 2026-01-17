/**
 * @fileoverview URL utility functions for the web crawler.
 *
 * This module provides essential URL processing functions used throughout the crawler:
 * - Normalization for consistent storage and deduplication
 * - Hashing for efficient lookup and comparison
 * - Filtering to avoid non-crawlable resources
 * - Priority calculation for intelligent crawl ordering
 *
 * URL normalization is critical for deduplication - without it, the same page
 * could be crawled multiple times under different URL representations
 * (e.g., with/without trailing slash, different param order).
 *
 * @module utils/url
 */

import crypto from 'crypto';

/**
 * Normalizes a URL for consistent storage and comparison.
 *
 * URL normalization is essential for deduplication because the same webpage
 * can be represented by many different URL strings:
 * - `https://Example.COM/path` vs `https://example.com/path`
 * - `https://example.com:443/path` vs `https://example.com/path`
 * - `https://example.com/path/` vs `https://example.com/path`
 * - `https://example.com?b=2&a=1` vs `https://example.com?a=1&b=2`
 *
 * Without normalization, the crawler would visit the same page multiple times.
 *
 * @param url - The URL string to normalize
 * @returns The normalized URL string, or the original if parsing fails
 *
 * @example
 * ```typescript
 * normalizeUrl('HTTPS://Example.COM:443/Path/')
 * // Returns: 'https://example.com/Path'
 *
 * normalizeUrl('https://example.com?b=2&a=1')
 * // Returns: 'https://example.com?a=1&b=2'
 *
 * normalizeUrl('https://example.com/page#section')
 * // Returns: 'https://example.com/page' (fragment removed)
 * ```
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Lowercase protocol and hostname
    let normalized = `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}`;

    // Remove default ports
    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      // Don't add port
    } else if (parsed.port) {
      normalized += `:${parsed.port}`;
    }

    // Add path (remove trailing slash except for root)
    let path = parsed.pathname;
    if (path !== '/' && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    normalized += path;

    // Sort query parameters
    if (parsed.search) {
      const params = new URLSearchParams(parsed.search);
      const sortedParams = new URLSearchParams([...params.entries()].sort());
      const queryString = sortedParams.toString();
      if (queryString) {
        normalized += `?${queryString}`;
      }
    }

    // Ignore fragment/hash

    return normalized;
  } catch {
    return url;
  }
}

/**
 * Generates a SHA-256 hash of a URL for efficient storage and lookup.
 *
 * URL hashes are used instead of raw URLs for several reasons:
 * 1. Fixed 64-character length regardless of URL length
 * 2. O(1) equality comparison vs O(n) string comparison
 * 3. Memory-efficient for storing billions of visited URLs
 * 4. Safe for use as database keys and Redis set members
 *
 * The URL is normalized before hashing to ensure different representations
 * of the same page produce the same hash.
 *
 * @param url - The URL to hash
 * @returns 64-character hexadecimal SHA-256 hash string
 *
 * @example
 * ```typescript
 * hashUrl('https://example.com/page')
 * // Returns: 'a1b2c3d4e5f6...' (64 hex chars)
 *
 * // Same page, different representation = same hash
 * hashUrl('HTTPS://Example.COM/page') === hashUrl('https://example.com/page')
 * // true
 * ```
 */
export function hashUrl(url: string): string {
  const normalized = normalizeUrl(url);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generates a SHA-256 hash of page content for duplicate detection.
 *
 * Content hashing enables near-duplicate detection across different URLs.
 * Many websites serve identical content under multiple URLs (mirrors,
 * pagination with same content, URL rewrites). By hashing content,
 * we can detect and skip pages we've already indexed.
 *
 * @param content - The page content (HTML, text, etc.) to hash
 * @returns 64-character hexadecimal SHA-256 hash string
 *
 * @example
 * ```typescript
 * const hash1 = hashContent('<html><body>Hello World</body></html>');
 * const hash2 = hashContent('<html><body>Hello World</body></html>');
 * hash1 === hash2 // true - same content produces same hash
 * ```
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Extracts the domain (hostname) from a URL.
 *
 * Domain extraction is used for:
 * - Per-domain rate limiting (politeness)
 * - Per-domain robots.txt lookup
 * - Domain-based statistics and reporting
 * - Grouping URLs by site for batch processing
 *
 * @param url - The URL to extract the domain from
 * @returns The lowercase hostname, or empty string if parsing fails
 *
 * @example
 * ```typescript
 * extractDomain('https://WWW.Example.COM/page?query=1')
 * // Returns: 'www.example.com'
 *
 * extractDomain('invalid-url')
 * // Returns: ''
 * ```
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Calculates the depth of a URL based on path segments.
 *
 * URL depth is used for priority calculation. Shallower pages (fewer path
 * segments) are typically more important:
 * - Depth 0: Homepage (/)
 * - Depth 1: Top-level sections (/about, /products)
 * - Depth 2+: Nested content (/products/category/item)
 *
 * Prioritizing by depth ensures the crawler indexes important pages first
 * before diving deep into site hierarchies.
 *
 * @param url - The URL to calculate depth for
 * @returns The number of non-empty path segments (0 for root)
 *
 * @example
 * ```typescript
 * calculateDepth('https://example.com/')
 * // Returns: 0
 *
 * calculateDepth('https://example.com/about')
 * // Returns: 1
 *
 * calculateDepth('https://example.com/products/electronics/phones')
 * // Returns: 3
 * ```
 */
export function calculateDepth(url: string): number {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === '/' || path === '') {
      return 0;
    }
    return path.split('/').filter((segment) => segment.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Determines if a URL should be crawled based on basic filtering rules.
 *
 * This function performs fast client-side filtering before URLs enter the
 * frontier. It filters out:
 * - Non-HTTP protocols (ftp, file, data, etc.)
 * - Binary files (images, videos, documents)
 * - Static assets (CSS, JS, fonts)
 *
 * This reduces wasted work and storage for non-indexable resources.
 * Note: This is in addition to robots.txt checks, not a replacement.
 *
 * @param url - The URL to check
 * @returns true if the URL should be crawled, false otherwise
 *
 * @example
 * ```typescript
 * shouldCrawl('https://example.com/page')
 * // Returns: true
 *
 * shouldCrawl('https://example.com/image.jpg')
 * // Returns: false (image file)
 *
 * shouldCrawl('ftp://example.com/file')
 * // Returns: false (non-HTTP protocol)
 * ```
 */
export function shouldCrawl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only crawl HTTP/HTTPS
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // Skip common non-content file extensions
    const skipExtensions = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.bmp',
      '.webp',
      '.svg',
      '.ico',
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.zip',
      '.rar',
      '.tar',
      '.gz',
      '.7z',
      '.mp3',
      '.mp4',
      '.avi',
      '.mov',
      '.wmv',
      '.flv',
      '.wav',
      '.woff',
      '.woff2',
      '.ttf',
      '.eot',
      '.css',
      '.js',
      '.json',
      '.xml',
    ];

    const path = parsed.pathname.toLowerCase();
    if (skipExtensions.some((ext) => path.endsWith(ext))) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Calculates the priority score for a URL in the crawl queue.
 *
 * Priority determines the order in which URLs are fetched from the frontier.
 * Higher priority URLs are crawled first. The scoring considers:
 * - Homepages always get highest priority (3)
 * - Depth: Shallower pages are more important
 * - URL patterns: Boost valuable pages (/about, /products), demote noise (/page/, /archive/)
 *
 * This ensures the crawler focuses on high-value content and doesn't get
 * lost in infinite pagination, tag pages, or deep archives.
 *
 * Priority levels:
 * - 3 (High): Seed URLs, homepages, shallow content
 * - 2 (Medium): Regular content pages
 * - 1 (Low): Paginated content, archives, deep pages
 *
 * @param url - The URL to calculate priority for
 * @param depth - The depth of the URL (from calculateDepth)
 * @param isHomepage - Whether this is a homepage/seed URL
 * @returns Priority score: 1 (low), 2 (medium), or 3 (high)
 *
 * @example
 * ```typescript
 * calculatePriority('https://example.com/', 0, true)
 * // Returns: 3 (homepage)
 *
 * calculatePriority('https://example.com/about', 1, false)
 * // Returns: 3 (shallow + valuable pattern)
 *
 * calculatePriority('https://example.com/blog?page=50', 1, false)
 * // Returns: 2 (shallow but pagination pattern demotes)
 * ```
 */
export function calculatePriority(
  url: string,
  depth: number,
  isHomepage: boolean = false
): number {
  let score = 2; // Default medium priority

  // Homepages get highest priority
  if (isHomepage) {
    return 3;
  }

  // Shallow pages get higher priority
  if (depth <= 1) {
    score = 3;
  } else if (depth <= 3) {
    score = 2;
  } else {
    score = 1;
  }

  // Boost certain URL patterns
  const patterns = {
    high: ['/about', '/contact', '/products', '/services', '/blog'],
    low: [
      '/tag/',
      '/page/',
      '/archive/',
      '/author/',
      '?sort=',
      '?filter=',
      '?page=',
    ],
  };

  const urlLower = url.toLowerCase();

  if (patterns.high.some((p) => urlLower.includes(p))) {
    score = Math.min(3, score + 1);
  }
  if (patterns.low.some((p) => urlLower.includes(p))) {
    score = Math.max(1, score - 1);
  }

  return score;
}

/**
 * Resolves a potentially relative URL against a base URL.
 *
 * When extracting links from HTML pages, links can be:
 * - Absolute: `https://other.com/page`
 * - Protocol-relative: `//other.com/page`
 * - Root-relative: `/other-page`
 * - Relative: `../sibling` or `child`
 *
 * This function converts all forms to absolute URLs for storage in the frontier.
 * It also filters out non-HTTP schemes (javascript:, mailto:, tel:, data:)
 * that shouldn't be crawled.
 *
 * @param baseUrl - The URL of the page containing the link
 * @param href - The href attribute value from the link
 * @returns The absolute URL, or null if the link should be ignored
 *
 * @example
 * ```typescript
 * resolveUrl('https://example.com/page', '/about')
 * // Returns: 'https://example.com/about'
 *
 * resolveUrl('https://example.com/dir/page', '../other')
 * // Returns: 'https://example.com/other'
 *
 * resolveUrl('https://example.com/', 'javascript:void(0)')
 * // Returns: null (non-HTTP scheme)
 *
 * resolveUrl('https://example.com/', 'mailto:test@example.com')
 * // Returns: null (non-HTTP scheme)
 * ```
 */
export function resolveUrl(baseUrl: string, href: string): string | null {
  try {
    // Handle javascript: and mailto: links
    if (
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:') ||
      href.startsWith('data:')
    ) {
      return null;
    }

    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}
