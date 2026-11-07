/**
 * Prefixed, time-ordered identifiers (ULID layout: 48-bit milliseconds then
 * 80 random bits, Crockford base32). The prefix says what a pasted id refers
 * to (run_, cr_, dsv_); time order keeps index inserts append-mostly.
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
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      rand += ALPHABET[(acc >> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return time + rand
}

export const newId = (prefix: string) => `${prefix}_${ulid()}`

/** Fencing token for one lease. */
export const newLeaseToken = () => randomBytes(9).toString('base64url')
