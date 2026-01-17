import crypto from 'crypto';

/**
 * Normalize a URL for consistent storage and comparison
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
 * Generate SHA-256 hash of a URL for efficient storage and lookup
 */
export function hashUrl(url: string): string {
  const normalized = normalizeUrl(url);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate SHA-256 hash of content for duplicate detection
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Extract domain from URL
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
 * Calculate URL depth (number of path segments)
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
 * Check if URL should be crawled (basic filtering)
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
 * Calculate priority score for a URL
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
 * Convert absolute/relative URL to absolute URL
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
