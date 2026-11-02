/**
 * Parses a dollar amount typed by the user ("12", "12.5", "12.50") into
 * integer cents without going through floating point. Returns null for
 * anything that isn't a positive amount with at most two decimals, so
 * "12.345" is refused instead of being silently rounded.
 */
export function parseDollarsToCents(input: string): number | null {
  const match = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Formats integer cents as US dollars. */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/**
 * A fresh idempotency key for one payment attempt. The form keeps the same key
 * across retries of that attempt (a timeout, a double click), so the server
 * replays the first result instead of moving money twice.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID only exists in secure contexts (https or localhost).
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
