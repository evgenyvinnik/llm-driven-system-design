/**
 * Distributed rate limiting.
 *
 * express-rate-limit's default MemoryStore counts per process, so N API instances
 * allowed N times the configured limit. This module plugs a small Redis fixed-window
 * store into express-rate-limit, so every instance shares one counter per client and
 * window, and the library still emits the standard RateLimit headers.
 *
 * Failure policy is fail-open: while Redis is down (or slow) requests pass unlimited
 * rather than being rejected or delayed. Losing rate limiting during a cache outage is
 * the lesser evil for a redirect service.
 */
import rateLimit, { Options, Store, IncrementResponse, RateLimitRequestHandler } from 'express-rate-limit';
import { Request, Response } from 'express';
import { redis, isRedisConnected } from '../utils/cache.js';
import { RATE_LIMIT_CONFIG } from '../config.js';
import { rateLimitHitsTotal } from '../utils/metrics.js';

/**
 * Lua fixed window: increment, start the window on the first hit, and return the hit
 * count with the milliseconds left in the window. Re-arms the expiry if a key somehow
 * lost it, so a counter can never become permanent.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * Lua: decrement only an existing counter (a bare DECR on an expired key would create a
 * negative counter without a TTL).
 */
const DECREMENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/** Time budget for one Redis round trip before the limiter gives up and fails open. */
const STORE_TIMEOUT_MS = 250;

/**
 * Rejects if `promise` does not settle within `ms`.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Rate limit store timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Converts the fixed-window script reply into express-rate-limit's increment response.
 * @param reply - [hits, msUntilReset] from INCREMENT_SCRIPT
 * @param nowMs - Current epoch ms
 */
export function toIncrementResponse(reply: unknown, nowMs: number): IncrementResponse {
  const [hits, ttl] = Array.isArray(reply) ? reply : [];
  const totalHits = Number(hits);
  const msLeft = Number(ttl);
  if (!Number.isFinite(totalHits) || !Number.isFinite(msLeft)) {
    throw new Error('Unexpected reply from rate limit script');
  }
  return { totalHits, resetTime: new Date(nowMs + Math.max(msLeft, 0)) };
}

/**
 * express-rate-limit Store backed by a Redis fixed window (one key per client and
 * limiter, expiring with the window).
 */
export class RedisFixedWindowStore implements Store {
  /** Counters are shared across instances. */
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;

  /**
   * @param prefix - Redis key prefix, unique per limiter
   */
  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /**
   * Receives the limiter options (window length).
   */
  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  /**
   * Counts a hit for `key` and reports the window state.
   * Throws on Redis errors/timeouts; the limiter is configured to let the request pass.
   */
  async increment(key: string): Promise<IncrementResponse> {
    const reply = await withTimeout(
      redis.eval(INCREMENT_SCRIPT, 1, `${this.prefix}${key}`, this.windowMs),
      STORE_TIMEOUT_MS
    );
    return toIncrementResponse(reply, Date.now());
  }

  /**
   * Undoes a hit (used by express-rate-limit's skip*Requests options).
   */
  async decrement(key: string): Promise<void> {
    await withTimeout(redis.eval(DECREMENT_SCRIPT, 1, `${this.prefix}${key}`), STORE_TIMEOUT_MS);
  }

  /**
   * Clears a client's counter.
   */
  async resetKey(key: string): Promise<void> {
    await redis.del(`${this.prefix}${key}`);
  }
}

/**
 * Builds a Redis-backed limiter keyed by client IP.
 * @param name - Limiter name (Redis prefix and metric label)
 * @param windowMs - Window length
 * @param limit - Requests allowed per window
 * @param message - Error message for 429 responses
 */
function createLimiter(name: string, windowMs: number, limit: number, message: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7', // RateLimit-Policy + RateLimit headers
    legacyHeaders: false,
    store: new RedisFixedWindowStore(`rl:${name}:`),
    // Fail open: skip limiting entirely while Redis is not ready (no per-request wait),
    // and let a request through if a Redis call errors or times out.
    skip: () => !isRedisConnected(),
    passOnStoreError: true,
    handler: (_req: Request, res: Response) => {
      rateLimitHitsTotal.inc({ endpoint: name });
      res.status(429).json({ error: message });
    },
  });
}

/**
 * General API limit (200 requests/minute per IP across all instances).
 */
export const generalLimiter = createLimiter(
  'general',
  RATE_LIMIT_CONFIG.general.windowMs,
  RATE_LIMIT_CONFIG.general.max,
  'Too many requests, please try again later'
);

/**
 * URL creation limit (100 links/hour per IP across all instances).
 */
export const createUrlLimiter = createLimiter(
  'create_url',
  RATE_LIMIT_CONFIG.createUrl.windowMs,
  RATE_LIMIT_CONFIG.createUrl.max,
  'Too many URLs created, please try again later'
);
