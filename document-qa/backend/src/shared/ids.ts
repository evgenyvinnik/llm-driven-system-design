/**
 * Prefixed, time-ordered identifiers (ULID layout: 48-bit milliseconds then
 * 80 random bits, Crockford base32). Sorting by id sorts by creation time,
 * which keeps index inserts append-mostly, and the prefix says what a pasted
 * id refers to (doc_, ver_, job_, run_).
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
  document: () => `doc_${ulid()}`,
  version: () => `ver_${ulid()}`,
  job: () => `job_${ulid()}`,
  attempt: () => `att_${ulid()}`,
  run: () => `run_${ulid()}`,
}

/** Chunk ids are derived, not random: a redone chunk stage writes the same ids, so embeddings keyed by chunk id stay put. */
export function chunkId(versionId: string, ordinal: number): string {
  return `chk_${versionId.slice(4)}_${String(ordinal).padStart(4, '0')}`
}
