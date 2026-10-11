import rateLimit from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import type { Request } from 'express';
import { redis } from './redis.js';

/**
 * Counters live in Redis so each limit is global across API instances. The default in-process
 * store gives every instance its own budget: five instances would quietly allow five times the
 * configured rate.
 */
function redisStore(name: string): RedisStore {
  const store = new RedisStore({
    prefix: `teams:rl:${name}:`,
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<RedisReply>,
  });
  // The store loads its Lua scripts as soon as it is constructed and reloads them on first use if
  // that failed. Mark the eager attempt as handled so Redis being down at startup is logged by
  // the client instead of crashing the process with an unhandled rejection.
  store.incrementScriptSha.catch(() => {});
  store.getScriptSha.catch(() => {});
  return store;
}

/**
 * Authenticated requests are limited per account, anonymous ones per IP. Keying everything by IP
 * would put every user behind one proxy or NAT (the Vite dev proxy included) into a single bucket.
 */
function userOrIp(req: Request): string {
  return req.session?.userId ? `user:${req.session.userId}` : `ip:${req.ip}`;
}

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  // If Redis is unreachable, serve the request unlimited rather than failing it.
  passOnStoreError: true,
} as const;

/** General API rate limiter: 1000 requests per 15 minutes per user (or IP). */
export const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 1000,
  keyGenerator: userOrIp,
  store: redisStore('api'),
  message: { error: 'Too many requests, please try again later.' },
});

/** Authentication rate limiter: 50 attempts per 15 minutes per IP. */
export const authLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 50,
  store: redisStore('auth'),
  message: { error: 'Too many auth attempts, please try again later.' },
});

/** Message rate limiter: 120 messages per minute per user. */
export const messageLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: userOrIp,
  store: redisStore('messages'),
  message: { error: 'Too many messages, please slow down.' },
});
