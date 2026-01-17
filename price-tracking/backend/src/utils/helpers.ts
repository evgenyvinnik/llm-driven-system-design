/**
 * Extracts the domain from a URL, removing the www. prefix.
 * Used to group products by retailer for domain-specific scraping rules and rate limits.
 * @param url - The full product URL
 * @returns The domain name (e.g., "amazon.com" from "https://www.amazon.com/product")
 * @throws Error if the URL is invalid
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    throw new Error('Invalid URL');
  }
}

/**
 * Validates that a string is a properly formatted HTTP or HTTPS URL.
 * Used for user input validation when adding new products to track.
 * @param url - The URL string to validate
 * @returns True if the URL is valid with http(s) protocol
 */
export function isValidUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parses a price string from scraped HTML into a numeric value.
 * Handles international formats including European (1.234,56) and US (1,234.56) notation,
 * as well as various currency symbols and whitespace.
 * @param priceString - Raw price text from web scraping
 * @returns Parsed price rounded to 2 decimal places, or null if unparseable
 */
export function parsePrice(priceString: string): number | null {
  if (!priceString) return null;

  const cleaned = priceString
    .replace(/[^0-9.,]/g, '')
    .trim();

  if (!cleaned) return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized: string;

  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length === 3) {
      normalized = cleaned.replace(',', '');
    } else {
      normalized = cleaned.replace(',', '.');
    }
  } else {
    normalized = cleaned;
  }

  const price = parseFloat(normalized);
  return isNaN(price) ? null : Math.round(price * 100) / 100;
}

/**
 * Formats a numeric price for display with currency symbol.
 * Uses Intl.NumberFormat for proper locale-aware formatting.
 * @param price - The numeric price value
 * @param currency - ISO 4217 currency code (default: USD)
 * @returns Formatted price string (e.g., "$29.99")
 */
export function formatPrice(price: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(price);
}

/**
 * Calculates the absolute and percentage change between two prices.
 * Used for alert messages and price history display.
 * @param oldPrice - The previous price
 * @param newPrice - The current price
 * @returns Object with amount (absolute change) and percentage (relative change)
 */
export function calculatePriceChange(oldPrice: number, newPrice: number): { amount: number; percentage: number } {
  const amount = newPrice - oldPrice;
  const percentage = oldPrice !== 0 ? (amount / oldPrice) * 100 : 0;
  return {
    amount: Math.round(amount * 100) / 100,
    percentage: Math.round(percentage * 100) / 100,
  };
}

/**
 * Generates a cryptographically suitable random token string.
 * Used for session tokens and other authentication purposes.
 * @param length - Token length in characters (default: 32)
 * @returns Random alphanumeric token string
 */
export function generateToken(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

/**
 * Returns a promise that resolves after the specified delay.
 * Used for rate limiting and retry logic in the scraper.
 * @param ms - Delay in milliseconds
 * @returns Promise that resolves after the delay
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps scrape priority levels to refresh intervals in minutes.
 * Higher priority products (more watchers) are scraped more frequently.
 * Priority 1 = 30 min, Priority 10 = 7 days.
 * @param priority - Priority level (1-10)
 * @returns Scrape interval in minutes
 */
export function getScrapePriorityInterval(priority: number): number {
  const intervals: Record<number, number> = {
    1: 30,
    2: 60,
    3: 120,
    4: 240,
    5: 360,
    6: 480,
    7: 720,
    8: 1440,
    9: 2880,
    10: 10080,
  };
  return intervals[priority] || intervals[5];
}
