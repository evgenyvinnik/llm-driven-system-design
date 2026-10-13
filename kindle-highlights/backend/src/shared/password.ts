/**
 * Password hashing with salted scrypt (node:crypto, no native dependency)
 * @module shared/password
 */
import crypto from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(crypto.scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

const KEY_LENGTH = 64
const PREFIX = 'scrypt'

/** Hashes a password as `scrypt:<salt hex>:<hash hex>` with a fresh 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(password, salt, KEY_LENGTH)
  return `${PREFIX}:${salt.toString('hex')}:${hash.toString('hex')}`
}

/**
 * Verifies a password against a stored hash. Accounts created before the scrypt switch hold an
 * unsalted SHA-256 hex digest; those still verify, and `needsRehash` tells the caller to
 * replace the stored hash now that it has the plaintext.
 */
export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  if (stored.startsWith(`${PREFIX}:`)) {
    const [, saltHex, hashHex] = stored.split(':')
    if (!saltHex || !hashHex) return { ok: false, needsRehash: false }
    const expected = Buffer.from(hashHex, 'hex')
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
    return { ok: actual.length === expected.length && crypto.timingSafeEqual(actual, expected), needsRehash: false }
  }
  const legacy = Buffer.from(crypto.createHash('sha256').update(password).digest('hex'))
  const expected = Buffer.from(stored)
  const ok = legacy.length === expected.length && crypto.timingSafeEqual(legacy, expected)
  return { ok, needsRehash: ok }
}
