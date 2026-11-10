/**
 * Random ids without dependencies: UUID v4 for event ids (ClickHouse dedups on
 * them), short ids for batches and SDK instances.
 * @module client/ids
 */

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

export function uuid(): string {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function shortId(prefix = ''): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return prefix + Array.from(randomBytes(12), (x) => alphabet[x % alphabet.length]).join('')
}
