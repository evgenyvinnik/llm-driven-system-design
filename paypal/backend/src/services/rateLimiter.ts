import type { Request } from 'express';
import rateLimit, { type Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { config } from '../config/index.js';
import { redis } from './redis.js';

/**
 * Counters live in Redis so every API instance (dev:server1-3 or a production
 * fleet) shares one budget; with the default in-memory store each process kept
 * its own count and a client could multiply its limit by the instance count.
 * Tests use the in-memory store so they don't need Redis.
 */
function makeStore(prefix: string): Store | undefined {
  if (config.nodeEnv === 'test') return undefined;
  const store = new RedisStore({
    prefix: `paypal:rl:${prefix}:`,
    sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as Promise<RedisReply>,
  });
  // The store loads its Lua scripts at construction. If Redis is down at boot
  // that promise rejects before anyone awaits it, which would crash the process
  // as an unhandled rejection; the store reloads the script on first use anyway.
  store.incrementScriptSha.catch(() => undefined);
  store.getScriptSha.catch(() => undefined);
  return store;
}

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  // If Redis is unavailable, allow the request rather than failing every call:
  // rate limiting degrades to off, payments keep working.
  passOnStoreError: true,
} as const;

/** General API rate limiter, per IP. */
export const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.apiPer15Min,
  store: makeStore('api'),
  message: { error: 'Too many requests, please try again later.' },
});

/** Login/register limiter, per IP, against password guessing. */
export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.authPer15Min,
  store: makeStore('auth'),
  message: { error: 'Too many auth attempts, please try again later.' },
});

/**
 * One budget per signed-in user shared by every endpoint that moves money:
 * transfers, paying a request, deposits and withdrawals. Keyed by user, not IP,
 * so users behind one NAT don't share a budget and one user can't spread
 * attempts over many IPs. Mounted after requireAuth, so the session is set.
 */
export const moneyLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: config.rateLimit.moneyPerMin,
  store: makeStore('money'),
  keyGenerator: (req: Request) => `user:${req.session?.userId ?? 'anonymous'}`,
  message: { error: 'Too many payment attempts, please try again later.' },
});
