/**
 * Idempotency keys for POST /api/v1/posts.
 *
 * A post upload is the request most likely to time out (several megabytes over a phone
 * connection) and the one where a blind retry does the most damage: a duplicate post in every
 * follower's feed. The client sends `Idempotency-Key: <uuid>` and reuses it for retries of the
 * same draft.
 *
 * The key row is inserted in the same transaction as the post, keyed by (user_id, key). That
 * primary key does the hard part: a concurrent retry's INSERT blocks until the first transaction
 * finishes, then conflicts, and the loser answers with the winner's post. Replaying a key with a
 * different request body is a client bug and gets 422.
 */
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from './db.js';

export const IDEMPOTENCY_KEY_TTL_HOURS = 24;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;

export const isValidIdempotencyKey = (key: string): boolean => KEY_PATTERN.test(key);

export interface CreatePostFingerprintInput {
  caption: string;
  location: string | null;
  filters: string[];
  files: { buffer: Buffer }[];
}

/** SHA-256 over everything that defines the post, including each file's content hash. */
export function fingerprintCreatePost(input: CreatePostFingerprintInput): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify({ caption: input.caption, location: input.location, filters: input.filters }));
  for (const file of input.files) {
    hash.update(crypto.createHash('sha256').update(file.buffer).digest('hex'));
  }
  return hash.digest('hex');
}

export interface StoredIdempotencyKey {
  requestHash: string;
  postId: string | null;
}

export async function findIdempotencyKey(userId: string, key: string): Promise<StoredIdempotencyKey | null> {
  const result = await query<{ request_hash: string; post_id: string | null }>(
    `SELECT request_hash, post_id FROM idempotency_keys
     WHERE user_id = $1 AND idempotency_key = $2
       AND created_at > NOW() - ($3::int * INTERVAL '1 hour')`,
    [userId, key, IDEMPOTENCY_KEY_TTL_HOURS]
  );
  const row = result.rows[0];
  return row ? { requestHash: row.request_hash, postId: row.post_id } : null;
}

/**
 * Claims the key for `postId` inside the caller's transaction. Returns false when another
 * request already holds it (the caller must roll back and replay that request's result).
 */
export async function claimIdempotencyKey(
  client: PoolClient,
  userId: string,
  key: string,
  requestHash: string,
  postId: string
): Promise<boolean> {
  // An expired key may be reused; clear it first so the insert below can succeed.
  await client.query(
    `DELETE FROM idempotency_keys
     WHERE user_id = $1 AND idempotency_key = $2 AND created_at <= NOW() - ($3::int * INTERVAL '1 hour')`,
    [userId, key, IDEMPOTENCY_KEY_TTL_HOURS]
  );
  const result = await client.query(
    `INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, post_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING post_id`,
    [userId, key, requestHash, postId]
  );
  return result.rows.length === 1;
}

/** Deletes keys past their retention window. Returns the number removed. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const result = await query(`DELETE FROM idempotency_keys WHERE created_at <= NOW() - ($1::int * INTERVAL '1 hour')`, [
    IDEMPOTENCY_KEY_TTL_HOURS,
  ]);
  return result.rowCount ?? 0;
}
