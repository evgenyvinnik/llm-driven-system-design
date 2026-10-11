import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { Request } from 'express';
import { config } from '../config/index.js';
import { redis } from './redis.js';

/**
 * Counters live in Redis so every API instance shares one budget per client; with the
 * default in-memory store, N instances behind a load balancer would allow N times the
 * limit. Tests use the in-memory store so they need no Redis.
 */
function redisStore(name: string): RedisStore | undefined {
  if (config.nodeEnv === 'test') return undefined;
  const store = new RedisStore({
    prefix: `loom:rl:${name}:`,
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
  });
  // The store loads its Lua scripts eagerly. If Redis is still connecting those promises
  // can reject before anything awaits them; the store reloads on first use anyway.
  store.incrementScriptSha.catch(() => undefined);
  store.getScriptSha.catch(() => undefined);
  return store;
}

function limiter(name: string, options: Partial<Options>) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: redisStore(name),
    ...options,
  });
}

/** General API rate limiter: 1000 requests per 15 minutes. Fails open if Redis is down. */
export const apiLimiter = limiter('api', {
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  passOnStoreError: true,
  message: { error: 'Too many requests, please try again later.' },
});

/** Authentication rate limiter: 50 attempts per 15 minutes. Fails closed: it guards passwords. */
export const authLimiter = limiter('auth', {
  windowMs: 15 * 60 * 1000,
  limit: 50,
  message: { error: 'Too many auth attempts, please try again later.' },
});

/** Upload limiter: 10 new upload sessions per minute per client. */
export const uploadLimiter = limiter('upload', {
  windowMs: 60 * 1000,
  limit: 10,
  passOnStoreError: true,
  message: { error: 'Too many upload requests, please try again later.' },
});

/**
 * Share password attempts: 10 per 15 minutes per client and link. Each attempt costs a
 * bcrypt comparison (~100 ms of CPU), so this limiter is both brute-force protection and
 * a CPU budget. Fails closed for the same reason.
 */
export const sharePasswordLimiter = limiter('share-pw', {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req: Request) => `${req.ip}:${req.params.token}`,
  message: { error: 'Too many password attempts for this link, please try again later.' },
});
