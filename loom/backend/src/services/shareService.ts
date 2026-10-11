import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

/** Generates a 256-bit cryptographically random share token. */
export function generateShareToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Creates a share link for a video with optional password protection and expiration. */
export async function createShare(
  videoId: string,
  options: {
    password?: string;
    expiresAt?: Date | null;
    allowDownload?: boolean;
  } = {},
): Promise<{ id: string; token: string; expiresAt: string | null; allowDownload: boolean }> {
  const token = generateShareToken();
  let passwordHash: string | null = null;

  if (options.password) {
    passwordHash = await bcrypt.hash(options.password, 10);
  }

  const result = await pool.query(
    `INSERT INTO shares (video_id, token, password_hash, expires_at, allow_download)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, token, expires_at, allow_download`,
    [videoId, token, passwordHash, options.expiresAt ?? null, options.allowDownload || false],
  );

  const share = result.rows[0];
  return {
    id: share.id,
    token: share.token,
    expiresAt: share.expires_at,
    allowDownload: share.allow_download,
  };
}

/** A share link as the access endpoints need it. */
export interface ShareRecord {
  id: string;
  videoId: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  allowDownload: boolean;
}

export type ShareLookup =
  | { status: 'ok'; share: ShareRecord }
  | { status: 'not_found' }
  | { status: 'expired' };

/** Looks a share up by token. Unknown and revoked tokens are indistinguishable by design. */
export async function findShareByToken(token: string): Promise<ShareLookup> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) {
    return { status: 'not_found' };
  }
  const result = await pool.query(
    `SELECT id, video_id, password_hash, expires_at, allow_download
     FROM shares WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return { status: 'not_found' };
  const expiresAt: Date | null = row.expires_at ? new Date(row.expires_at) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) return { status: 'expired' };
  return {
    status: 'ok',
    share: {
      id: row.id,
      videoId: row.video_id,
      passwordHash: row.password_hash,
      expiresAt,
      allowDownload: row.allow_download,
    },
  };
}

/** Verifies a share password. This is the expensive call the share grant exists to avoid repeating. */
export async function checkSharePassword(share: ShareRecord, password: unknown): Promise<boolean> {
  if (!share.passwordHash) return true;
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) return false;
  return bcrypt.compare(password, share.passwordHash);
}
