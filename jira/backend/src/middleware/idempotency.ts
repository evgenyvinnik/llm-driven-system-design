import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.js';
import { query } from '../config/database.js';
import { logger } from '../config/logger.js';
import { idempotentReplaysCounter } from '../config/metrics.js';

/**
 * Idempotency for non-idempotent writes (create issue, add comment, transitions).
 *
 * The client sends Idempotency-Key (X-Idempotency-Key is still accepted) with a value it
 * generates once per user intent and reuses for every retry of that intent. Then:
 * 1. The first request claims the key atomically (SET NX) and runs the handler.
 * 2. A duplicate that arrives while the first is still running gets 409 + Retry-After.
 * 3. Once the first finishes, duplicates get its stored response replayed verbatim.
 * 4. The same key with a different method, path or body gets 422: replaying the stored
 *    response would tell the client its new request succeeded when it never ran.
 * 5. A 5xx response is not stored; the claim is released so a retry can run again.
 *
 * Records live in Redis for 24 hours and are copied to the idempotency_keys table, which
 * is consulted when Redis no longer has a key (restart or eviction), so a replayed write
 * is still caught. The copy is written after the response, not in the handler's own
 * transaction, so a crash between the two can still let one duplicate through.
 */
export const IDEMPOTENCY_HEADERS = ['idempotency-key', 'x-idempotency-key'];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PROCESSING_TTL_SECONDS = 60;
const RESPONSE_TTL_SECONDS = 24 * 60 * 60;
const REDIS_PREFIX = 'jira:idempotency:';

interface ProcessingRecord {
  state: 'processing';
  fingerprint: string;
  started_at: string;
}

interface CompletedRecord {
  state: 'completed';
  fingerprint: string;
  status: number;
  body: unknown;
  created_at: string;
}

type IdempotencyRecord = ProcessingRecord | CompletedRecord;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Identifies the request a key was first used with: method, path and JSON body. */
export function requestFingerprint(req: Pick<Request, 'method' | 'originalUrl' | 'body'>): string {
  return sha256(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`);
}

function readKey(req: Request): string | undefined {
  for (const header of IDEMPOTENCY_HEADERS) {
    const value = req.get(header);
    if (value) return value.trim();
  }
  return undefined;
}

/** Answers a request whose key already has a record. */
function respondFromRecord(record: IdempotencyRecord, fingerprint: string, res: Response): void {
  if (record.fingerprint !== fingerprint) {
    res.status(422).json({
      error: 'This Idempotency-Key was already used for a different request',
      code: 'idempotency_key_reused',
    });
    return;
  }
  if (record.state === 'processing') {
    res.setHeader('Retry-After', '1');
    res.status(409).json({
      error: 'A request with this Idempotency-Key is still being processed',
      code: 'idempotency_in_progress',
    });
    return;
  }
  idempotentReplaysCounter.inc();
  res.setHeader('Idempotent-Replayed', 'true');
  res.status(record.status).json(record.body);
}

/** Durable copy for keys Redis no longer has (scope = "<userId>:<key>"). */
async function loadDurableRecord(scope: string, fingerprint: string): Promise<CompletedRecord | null> {
  const { rows } = await query<{ response_status: number; response_body: unknown; request_fingerprint: string | null; created_at: Date }>(
    `SELECT response_status, response_body, request_fingerprint, created_at
     FROM idempotency_keys
     WHERE key = $1 AND expires_at > NOW()`,
    [sha256(scope)]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    state: 'completed',
    fingerprint: row.request_fingerprint ?? fingerprint,
    status: row.response_status,
    body: row.response_body,
    created_at: new Date(row.created_at).toISOString(),
  };
}

async function storeRecord(
  redisKey: string,
  scope: string,
  userId: string | undefined,
  path: string,
  record: CompletedRecord
): Promise<void> {
  await redis.set(redisKey, JSON.stringify(record), 'EX', RESPONSE_TTL_SECONDS);
  if (!userId) return;
  await query(
    `INSERT INTO idempotency_keys
       (key, user_id, request_path, response_status, response_body, request_fingerprint, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours')
     ON CONFLICT (key) DO NOTHING`,
    [sha256(scope), userId, path.slice(0, 200), record.status, JSON.stringify(record.body ?? null), record.fingerprint]
  );
}

/**
 * Express middleware; mount it on /api after the session middleware so keys are scoped
 * per user (one user's key can never replay another user's response).
 */
export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return next();

  const key = readKey(req);
  if (!key) return next();

  if (key.length > 255) {
    res.status(400).json({ error: 'Idempotency-Key must be at most 255 characters', code: 'invalid_request' });
    return;
  }

  const userId = req.session?.userId;
  const scope = `${userId ?? 'anonymous'}:${key}`;
  const redisKey = `${REDIS_PREFIX}${scope}`;
  const fingerprint = requestFingerprint(req);

  try {
    const processing: ProcessingRecord = { state: 'processing', fingerprint, started_at: new Date().toISOString() };
    const claimed = await redis.set(redisKey, JSON.stringify(processing), 'EX', PROCESSING_TTL_SECONDS, 'NX');

    if (claimed !== 'OK') {
      const raw = await redis.get(redisKey);
      if (raw) {
        respondFromRecord(JSON.parse(raw) as IdempotencyRecord, fingerprint, res);
      } else {
        // The claim expired between SET and GET; ask the client to retry.
        res.setHeader('Retry-After', '1');
        res.status(409).json({ error: 'Please retry', code: 'idempotency_in_progress' });
      }
      return;
    }

    const durable = userId ? await loadDurableRecord(scope, fingerprint) : null;
    if (durable) {
      await redis.set(redisKey, JSON.stringify(durable), 'EX', RESPONSE_TTL_SECONDS);
      respondFromRecord(durable, fingerprint, res);
      return;
    }
  } catch (error) {
    // Fail open: without Redis the session store is down too, so this rarely matters,
    // and refusing every write would turn a cache outage into a full outage.
    logger.error({ err: error }, 'Idempotency check failed; continuing without it');
    return next();
  }

  let captured: { status: number; body: unknown } | null = null;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    captured = { status: res.statusCode, body };
    return originalJson(body);
  };

  res.on('finish', () => {
    const result = captured as { status: number; body: unknown } | null;
    const finalize =
      result && result.status < 500 && result.status !== 429
        ? storeRecord(redisKey, scope, userId, req.originalUrl, {
            state: 'completed',
            fingerprint,
            status: result.status,
            body: result.body,
            created_at: new Date().toISOString(),
          })
        : redis.del(redisKey).then(() => undefined);
    finalize.catch((error: Error) => {
      logger.error({ err: error }, 'Failed to finalize idempotency record');
    });
  });

  next();
}

export default idempotencyMiddleware;
