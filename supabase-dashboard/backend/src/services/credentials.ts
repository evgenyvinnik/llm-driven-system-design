import crypto from 'crypto';
import { config } from '../config/index.js';
import { pool } from './db.js';
import { logger } from './logger.js';
import { ApiError } from './errors.js';

/**
 * Target-database passwords are stored AES-256-GCM encrypted, keyed from
 * TARGET_CREDENTIALS_KEY (environment, not the database). A dump of
 * supabase_meta, a backup, or a SQL path into the metadata DB then yields
 * ciphertext rather than working credentials for every tenant's database.
 *
 * Stored format: `enc:v1:<iv>:<tag>:<ciphertext>` (base64). Values without the
 * prefix are legacy plaintext (the seed, rows written before this existed);
 * they still decrypt to themselves and `encryptLegacyPasswords` rewrites them
 * at startup.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer {
  return crypto.createHash('sha256').update(config.credentials.key).digest();
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((b) => b.toString('base64')).join(':');
}

export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  try {
    const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key (TARGET_CREDENTIALS_KEY changed) or a tampered value: say so plainly
    // instead of trying to connect with garbage.
    throw new ApiError(
      500,
      'Stored database credentials could not be decrypted. Re-enter the database password in project settings.',
    );
  }
}

/** Encrypts any plaintext db_password rows left by the seed or older versions. */
export async function encryptLegacyPasswords(): Promise<number> {
  if (config.credentials.usingDevKey && config.nodeEnv === 'production') {
    logger.warn('TARGET_CREDENTIALS_KEY is not set; target credentials are encrypted with the development key');
  }
  const result = await pool.query(`SELECT id, db_password FROM projects WHERE db_password NOT LIKE 'enc:v1:%'`);
  let updated = 0;
  for (const row of result.rows as { id: string; db_password: string }[]) {
    // Compare-and-set so a concurrent settings update is never overwritten with the old password.
    const res = await pool.query('UPDATE projects SET db_password = $1 WHERE id = $2 AND db_password = $3', [
      encryptSecret(row.db_password),
      row.id,
      row.db_password,
    ]);
    updated += res.rowCount ?? 0;
  }
  if (updated > 0) logger.info({ updated }, 'Encrypted legacy plaintext target passwords');
  return updated;
}
