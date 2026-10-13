/**
 * Idempotency keys for non-idempotent POSTs (order checkout).
 *
 * One key per checkout attempt: retries of the same attempt reuse it, a changed
 * cart gets a new one. crypto.randomUUID needs a secure context (https or
 * localhost); the fallback covers plain-http LAN testing.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
