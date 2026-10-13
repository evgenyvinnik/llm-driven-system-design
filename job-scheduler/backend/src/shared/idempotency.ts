/**
 * Idempotency-Key support for non-idempotent POSTs (create job, trigger, retry).
 *
 * A client that may retry a request (timeout, double click, flaky network) sends the
 * same `Idempotency-Key` header on every attempt. The first request does the work and
 * its response is stored; later requests with the same key get the stored response
 * instead of creating a second job or a second run.
 * @module shared/idempotency
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { redis } from '../queue/redis';
import { logger } from '../utils/logger';

/** Prefix for Redis keys storing idempotency records */
const IDEMPOTENCY_PREFIX = 'job_scheduler:idempotency:';

/** How long a completed response is replayed for (24 hours) */
const RESPONSE_TTL_SECONDS = 86400;

/**
 * How long an in-flight claim lives. If the process dies mid-request the key frees
 * itself after this, instead of answering "still processing" for a whole day.
 */
const IN_FLIGHT_TTL_SECONDS = 60;

/** Longest accepted header value */
const MAX_KEY_LENGTH = 255;

/** What is stored under an idempotency key. */
interface IdempotencyRecord {
  state: 'in_flight' | 'done';
  /** Hash of the request body; a reused key with a different body is rejected. */
  fingerprint: string;
  statusCode?: number;
  body?: unknown;
}

/** SHA-256 of the request body, so the stored record never holds the payload itself. */
function fingerprintOf(req: Request): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(req.body ?? null))
    .digest('hex');
}

/**
 * Express middleware implementing Idempotency-Key semantics (in the style of the IETF
 * draft and Stripe's API):
 *
 * - No header: the request runs normally. Deduplication is opt-in; two deliberate,
 *   identical requests are not merged.
 * - First request with a key: claimed atomically with SET NX, so two concurrent
 *   duplicates cannot both run. Its response is stored for 24 hours, unless it is a 5xx,
 *   in which case the claim is dropped so the client can retry for real.
 * - Same key, same body, finished: the stored status and body are replayed
 *   (`Idempotent-Replayed: true`).
 * - Same key, still running: 409 with `Retry-After: 1`.
 * - Same key, different body: 422, because the client is reusing a key for a
 *   different operation.
 * - Redis unavailable: 503 rather than silently running without the guarantee.
 *
 * Keys are scoped by user, method and path, so one user's key can never replay
 * another user's response.
 */
export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientKey = req.header('Idempotency-Key');
    if (!clientKey) {
      return next();
    }

    if (clientKey.length > MAX_KEY_LENGTH) {
      res.status(400).json({ success: false, error: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters` });
      return;
    }

    const scope = req.user?.userId ?? 'anonymous';
    const key = `${IDEMPOTENCY_PREFIX}${scope}:${req.method}:${req.baseUrl}${req.path}:${clientKey}`;
    const fingerprint = fingerprintOf(req);

    let claimed: boolean;
    let existing: IdempotencyRecord | null = null;
    try {
      const inFlight: IdempotencyRecord = { state: 'in_flight', fingerprint };
      claimed = (await redis.set(key, JSON.stringify(inFlight), 'EX', IN_FLIGHT_TTL_SECONDS, 'NX')) === 'OK';
      if (!claimed) {
        const raw = await redis.get(key);
        existing = raw ? (JSON.parse(raw) as IdempotencyRecord) : null;
      }
    } catch (error) {
      logger.error({ err: error }, 'Idempotency store unavailable');
      res.setHeader('Retry-After', '1');
      res.status(503).json({ success: false, error: 'Idempotency store unavailable, retry shortly' });
      return;
    }

    if (!claimed) {
      if (existing && existing.fingerprint !== fingerprint) {
        res.status(422).json({
          success: false,
          error: 'Idempotency-Key was already used with a different request body',
        });
        return;
      }
      if (!existing || existing.state === 'in_flight') {
        // Still running (or the record expired between our two calls): ask the client
        // to come back rather than risk running the operation twice.
        res.setHeader('Retry-After', '1');
        res.status(409).json({
          success: false,
          error: 'A request with this Idempotency-Key is still being processed',
        });
        return;
      }
      logger.info({ key }, 'Replaying stored idempotent response');
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(existing.statusCode ?? 200).json(existing.body);
      return;
    }

    // Store the outcome before the client sees it, so a retry that arrives right after
    // the response finds the stored record, not the in-flight claim.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown): Response => {
      const statusCode = res.statusCode;
      const persist = statusCode >= 500
        ? redis.del(key)
        : redis.set(
          key,
          JSON.stringify({ state: 'done', fingerprint, statusCode, body } satisfies IdempotencyRecord),
          'EX',
          RESPONSE_TTL_SECONDS
        );
      void persist
        .catch((error: unknown) => logger.error({ err: error, key }, 'Failed to store idempotency record'))
        .then(() => {
          originalJson(body);
        })
        .catch((error: unknown) => logger.error({ err: error, key }, 'Failed to send response'));
      return res;
    }) as Response['json'];

    next();
  };
}

logger.info('Idempotency module initialized');
