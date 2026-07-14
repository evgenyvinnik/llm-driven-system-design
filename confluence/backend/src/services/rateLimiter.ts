import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from './redis.js';

/** General API rate limiter: 500 requests per 15-minute window via Redis. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
    prefix: 'rl:api:',
  }),
  message: { error: 'Too many requests, please try again later' },
});

/** Authentication rate limiter: 20 requests per 15-minute window via Redis. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
    prefix: 'rl:auth:',
  }),
  message: { error: 'Too many auth attempts, please try again later' },
});
