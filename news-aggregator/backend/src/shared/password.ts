/**
 * Password hashing with scrypt (built into node:crypto, no native addon).
 *
 * Stored format: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>. Each hash has
 * its own random salt and records its cost parameters, so the parameters can
 * be raised later without invalidating existing hashes.
 *
 * Legacy rows hold sha256(password + 'salt') as 64 hex characters (the scheme
 * this project used before 2026-10, still in the seed). They still verify,
 * report needsRehash, and are replaced with an scrypt hash at the next login.
 * @module shared/password
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>;

/** Cost parameters for new hashes (N=2^14 uses ~16 MB and ~50 ms). */
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const LEGACY_HASH = /^[0-9a-f]{64}$/;

/** Result of checking a password against a stored hash. */
export interface PasswordCheck {
  valid: boolean;
  /** True when the stored hash uses an outdated scheme and should be replaced */
  needsRehash: boolean;
}

/**
 * Hash a password for storage.
 * @param password - Plain text password
 * @returns Self-describing scrypt hash string
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, { ...PARAMS, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Verify a password against a stored hash in constant time.
 * @param password - Plain text password to check
 * @param stored - Hash from the users table
 * @returns Whether it matches, and whether the hash should be upgraded
 */
export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
  if (LEGACY_HASH.test(stored)) {
    const legacy = crypto.createHash('sha256').update(password + 'salt').digest();
    const valid = crypto.timingSafeEqual(legacy, Buffer.from(stored, 'hex'));
    return { valid, needsRehash: valid };
  }

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return { valid: false, needsRehash: false };
  }
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!expected.length || !Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return { valid: false, needsRehash: false };
  }

  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    ...params,
    maxmem: 64 * 1024 * 1024,
  });
  const valid = crypto.timingSafeEqual(actual, expected);
  const outdated = params.N < PARAMS.N || params.r !== PARAMS.r || params.p !== PARAMS.p;
  return { valid, needsRehash: valid && outdated };
}
