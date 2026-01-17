import crypto from 'crypto';

// Generate a hash for a URL
export const hashUrl = (url) => {
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  // Convert first 16 hex chars to BigInt for storage
  return BigInt('0x' + hash.substring(0, 16)).toString();
};

// Generate a hash for content (deduplication)
export const hashContent = (content) => {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return BigInt('0x' + hash.substring(0, 16)).toString();
};

// Extract domain from URL
export const extractDomain = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
};

// Normalize URL (remove fragments, trailing slashes, etc.)
export const normalizeUrl = (url) => {
  try {
    const parsed = new URL(url);
    // Remove fragment
    parsed.hash = '';
    // Remove trailing slash (except for root)
    let normalized = parsed.href;
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
};

// Convert relative URL to absolute
export const toAbsoluteUrl = (relativeUrl, baseUrl) => {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch {
    return null;
  }
};

// Check if URL is valid for crawling
export const isValidUrl = (url) => {
  try {
    const parsed = new URL(url);
    // Only allow http and https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    // Skip common file extensions we don't want to crawl
    const skipExtensions = [
      '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico',
      '.css', '.js', '.woff', '.woff2', '.ttf', '.eot',
      '.zip', '.tar', '.gz', '.rar', '.7z',
      '.mp3', '.mp4', '.avi', '.mov', '.wmv',
      '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    ];
    const pathname = parsed.pathname.toLowerCase();
    for (const ext of skipExtensions) {
      if (pathname.endsWith(ext)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

// Calculate edit distance between two strings (Levenshtein)
export const editDistance = (str1, str2) => {
  const m = str1.length;
  const n = str2.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j - 1] + 1, // replace
          dp[i - 1][j] + 1,     // delete
          dp[i][j - 1] + 1      // insert
        );
      }
    }
  }

  return dp[m][n];
};

// Format bytes to human readable
export const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Sleep utility
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
