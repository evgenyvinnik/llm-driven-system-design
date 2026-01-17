export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove www. prefix if present
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    throw new Error('Invalid URL');
  }
}

export function isValidUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parsePrice(priceString: string): number | null {
  if (!priceString) return null;

  // Remove currency symbols, spaces, and other non-numeric characters except . and ,
  const cleaned = priceString
    .replace(/[^0-9.,]/g, '')
    .trim();

  if (!cleaned) return null;

  // Handle different decimal separators
  // If there's both . and ,, determine which is the decimal separator
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized: string;

  if (hasComma && hasDot) {
    // If comma comes after dot, comma is decimal (e.g., 1.234,56)
    // If dot comes after comma, dot is decimal (e.g., 1,234.56)
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    if (lastComma > lastDot) {
      // European format: 1.234,56
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // US format: 1,234.56
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Could be decimal separator (12,34) or thousands (1,234)
    // If there are 3 digits after comma, it's thousands
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

export function formatPrice(price: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(price);
}

export function calculatePriceChange(oldPrice: number, newPrice: number): { amount: number; percentage: number } {
  const amount = newPrice - oldPrice;
  const percentage = oldPrice !== 0 ? (amount / oldPrice) * 100 : 0;
  return {
    amount: Math.round(amount * 100) / 100,
    percentage: Math.round(percentage * 100) / 100,
  };
}

export function generateToken(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getScrapePriorityInterval(priority: number): number {
  // Returns interval in minutes
  const intervals: Record<number, number> = {
    1: 30,      // 30 minutes
    2: 60,      // 1 hour
    3: 120,     // 2 hours
    4: 240,     // 4 hours
    5: 360,     // 6 hours
    6: 480,     // 8 hours
    7: 720,     // 12 hours
    8: 1440,    // 1 day
    9: 2880,    // 2 days
    10: 10080,  // 7 days
  };
  return intervals[priority] || intervals[5];
}
