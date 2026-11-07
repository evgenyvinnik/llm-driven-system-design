/**
 * Prefixed, time-ordered identifiers (ULID layout: 48-bit milliseconds then
 * 80 random bits, Crockford base32). Sorting by id sorts by creation time,
 * which keeps index inserts append-mostly, and the prefix says what a pasted
 * id refers to (evt_, dlv_, ep_).
 * @module shared/ids
 */
import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = randomBytes(10)
  let rand = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      rand += ALPHABET[(acc >> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return time + rand
}

export const newId = {
  event: () => `evt_${ulid()}`,
  delivery: () => `dlv_${ulid()}`,
  endpoint: () => `ep_${ulid()}`,
  apiKey: () => `key_${ulid()}`,
}

/** A signing secret: 32 random bytes, base64url, with a recognisable prefix. */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

/** A producer API key. Returned once; only its SHA-256 is stored. */
export function newApiKey(): string {
  return `whk_${randomBytes(24).toString('base64url')}`
}
