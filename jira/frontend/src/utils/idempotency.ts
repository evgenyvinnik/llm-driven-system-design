/**
 * Creates an Idempotency-Key value: one per user intent (a submitted form, a comment
 * draft), reused for every retry of that intent and replaced once it has a definite
 * answer. crypto.randomUUID only exists in secure contexts (https or localhost), so plain
 * http hosts fall back to random bytes from crypto.getRandomValues.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
