/**
 * Idempotency middleware for URL creation.
 * Lets a client safely retry a create after a timeout or network error without minting
 * a second short link. Follows the IETF "Idempotency-Key HTTP Header Field" draft:
 *
 * - Only requests carrying an explicit Idempotency-Key header are deduplicated. Two
 *   identical bodies without a key are two intentional creations (the earlier body
 *   fingerprint fallback silently merged them).
 * - Keys are scoped per user ('anonymous' when unauthenticated).
 * - Reusing a key with a different body is a client error: 422.
 * - A retry that arrives while the original is still running gets 409 + Retry-After.
 * - A completed 2xx response is replayed verbatim for 24 hours.
 */
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { redis, isRedisConnected } from './cache.js';
import { IDEMPOTENCY_CONFIG } from '../config.js';
import logger from './logger.js';
import { idempotencyHitsTotal } from './metrics.js';

/**
 * Prefix for idempotency keys in Redis.
 */
const IDEMPOTENCY_PREFIX = 'idempotency:';

/**
 * Accepted key syntax: 1-255 visible ASCII characters (UUIDs fit comfortably).
 */
const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

/**
 * Lua: finish a claim only if we still own it (value unchanged since our SET NX).
 * ARGV[2] empty -> release (DEL); otherwise store the completed record with a TTL.
 * Prevents a request whose claim already expired from clobbering a newer claim.
 */
const FINISH_CLAIM = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 1
`;

/**
 * Record stored while the first request runs.
 */
interface ProcessingRecord {
  state: 'processing';
  fingerprint: string;
  token: string;
  started_at: string;
}

/**
 * Record stored after a successful response, replayed to retries.
 */
interface CompletedRecord {
  state: 'completed';
  fingerprint: string;
  status: number;
  body: unknown;
  created_at: string;
}

/**
 * What to do when the key is already present in Redis.
 */
export type ExistingRecordDecision =
  | { action: 'replay'; status: number; body: unknown }
  | { action: 'in_progress' }
  | { action: 'mismatch' }
  | { action: 'claim' };

/**
 * Validates the Idempotency-Key header value.
 * @param key - Header value (already trimmed)
 */
export function isValidIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Serializes JSON with object keys sorted, so the fingerprint ignores key order and
 * whitespace but not values.
 * @param value - Parsed JSON value
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprints a request (method, path, canonical body) with SHA-256.
 * @param method - HTTP method
 * @param path - Request path without query string
 * @param body - Parsed request body
 * @returns Hex digest
 */
export function fingerprintRequest(method: string, path: string, body: unknown): string {
  return crypto
    .createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(body ?? null)}`)
    .digest('hex');
}

/**
 * Decides how to answer a request whose key is already taken.
 * @param raw - Stored record (null if it vanished between SET NX and GET)
 * @param fingerprint - Fingerprint of the current request
 */
export function decideOnExistingRecord(raw: string | null, fingerprint: string): ExistingRecordDecision {
  if (raw === null) {
    return { action: 'claim' };
  }

  let record: { state?: unknown; fingerprint?: unknown; status?: unknown; body?: unknown };
  try {
    record = JSON.parse(raw);
  } catch {
    // Unreadable record: refuse to run the handler rather than risk a duplicate.
    return { action: 'in_progress' };
  }

  if (record.fingerprint !== fingerprint) {
    return { action: 'mismatch' };
  }
  if (record.state === 'completed' && typeof record.status === 'number') {
    return { action: 'replay', status: record.status, body: record.body };
  }
  return { action: 'in_progress' };
}

/**
 * Sends the response for a key that is already taken.
 */
function respondToExisting(res: Response, decision: Exclude<ExistingRecordDecision, { action: 'claim' }>, key: string): void {
  switch (decision.action) {
    case 'mismatch':
      res.status(422).json({ error: 'Idempotency-Key has already been used with a different request body' });
      return;
    case 'in_progress':
      res.set('Retry-After', String(IDEMPOTENCY_CONFIG.retryAfterSeconds));
      res.status(409).json({ error: 'A request with this Idempotency-Key is still being processed' });
      return;
    case 'replay':
      idempotencyHitsTotal.inc();
      logger.info({ idempotency_key: key }, 'Idempotency cache hit - returning cached response');
      res.set('Idempotent-Replayed', 'true');
      res.status(decision.status).json(decision.body);
      return;
  }
}

/**
 * Wraps res.json so the claim is completed (2xx: store the response) or released
 * (anything else: delete it, so a retry re-executes) when the handler responds.
 * If the process dies first, the claim simply expires after processingTTL.
 */
function attachCompletion(res: Response, redisKey: string, claimValue: string, fingerprint: string, key: string): void {
  const originalJson = res.json.bind(res);
  let finished = false;

  res.json = function (body?: unknown) {
    if (!finished) {
      finished = true;
      const success = res.statusCode >= 200 && res.statusCode < 300;
      const completed: CompletedRecord = {
        state: 'completed',
        fingerprint,
        status: res.statusCode,
        body,
        created_at: new Date().toISOString(),
      };
      redis
        .eval(
          FINISH_CLAIM,
          1,
          redisKey,
          claimValue,
          success ? JSON.stringify(completed) : '',
          IDEMPOTENCY_CONFIG.responseTTL
        )
        .catch((err) => {
          logger.error({ err, idempotency_key: key }, 'Failed to finalize idempotency key');
        });
    }
    return originalJson(body);
  };
}

/**
 * Middleware to handle idempotent URL creation requests.
 * Must run after authentication (the key is scoped by user). Fails open: if Redis is
 * unavailable the request proceeds without idempotency protection.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.method !== 'POST') {
    next();
    return;
  }

  const header = req.get('Idempotency-Key');
  if (header === undefined) {
    next();
    return;
  }

  const key = header.trim();
  if (!isValidIdempotencyKey(key)) {
    res.status(400).json({ error: 'Idempotency-Key must be 1-255 visible ASCII characters' });
    return;
  }

  if (!isRedisConnected()) {
    logger.warn({ idempotency_key: key }, 'Redis unavailable, proceeding without idempotency');
    next();
    return;
  }

  const redisKey = `${IDEMPOTENCY_PREFIX}${req.user?.id ?? 'anonymous'}:${key}`;
  const fingerprint = fingerprintRequest(req.method, `${req.baseUrl}${req.path}`, req.body);
  const claim: ProcessingRecord = {
    state: 'processing',
    fingerprint,
    token: crypto.randomUUID(),
    started_at: new Date().toISOString(),
  };
  const claimValue = JSON.stringify(claim);

  // Decide inside the try, act outside it, so an exception thrown downstream of next()
  // can never trigger a second next().
  let outcome: 'claimed' | 'unprotected' | Exclude<ExistingRecordDecision, { action: 'claim' }> = {
    action: 'in_progress',
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = await redis.set(redisKey, claimValue, 'EX', IDEMPOTENCY_CONFIG.processingTTL, 'NX');
      if (claimed === 'OK') {
        outcome = 'claimed';
        break;
      }
      const decision = decideOnExistingRecord(await redis.get(redisKey), fingerprint);
      if (decision.action !== 'claim') {
        outcome = decision;
        break;
      }
      // The record expired between SET NX and GET: try to claim once more.
    }
  } catch (error) {
    // If Redis fails, proceed without idempotency (graceful degradation)
    logger.error({ err: error }, 'Idempotency check failed, proceeding without it');
    outcome = 'unprotected';
  }

  if (outcome === 'claimed') {
    attachCompletion(res, redisKey, claimValue, fingerprint, key);
    next();
    return;
  }
  if (outcome === 'unprotected') {
    next();
    return;
  }
  respondToExisting(res, outcome, key);
}
