/**
 * Deterministic ids. A UUID derived from a name (SHA-1, RFC 4122 v5 layout) lets
 * a redelivered command produce the same aggregate id, so "create once" is
 * enforced by the event store's expected version 'no_stream'.
 * @module shared/ids
 */
import { createHash } from 'node:crypto'

export function uuidFromName(name: string): string {
  const h = createHash('sha1').update(`railcar-health:${name}`).digest()
  h[6] = (h[6] & 0x0f) | 0x50
  h[8] = (h[8] & 0x3f) | 0x80
  const hex = h.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
