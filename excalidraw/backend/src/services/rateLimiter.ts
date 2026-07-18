import rateLimit, { RateLimitRequestHandler, Options, ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type { Request, Response, NextFunction } from 'express';
import type { Session, SessionData } from 'express-session';
import redis from './redis.js';
import logger from './logger.js';
import { rateLimitHits } from './metrics.js';

interface ExtendedRequest extends Omit<Request, 'session'> {
  session: Session & Partial<SessionData> & {
    userId?: string;
    username?: string;
  };
}

interface RateLimiterOptions {
  keyPrefix: string;
  max: number;
  windowMs: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  actionName?: string;
}

/** Creates a Redis-backed rate limiter with per-user keys and custom limits. */
const createRateLimiter = (options: RateLimiterOptions): RateLimitRequestHandler => {
  const {
    keyPrefix,
    max,
    windowMs,
    message = 'Too many requests, please try again later.',
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    actionName = 'request',
  } = options;

  return rateLimit({
    store: new RedisStore({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendCommand: async (...args: string[]): Promise<any> => {
        const [command, ...rest] = args;
        return redis.call(command, ...rest);
      },
      prefix: `ratelimit:${keyPrefix}:`,
    }),
    max,
    windowMs,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    skipFailedRequests,
    keyGenerator: (req: ExtendedRequest): string => {
      return req.session?.userId || ipKeyGenerator(req.ip || '0.0.0.0') || 'unknown';
    },
    handler: (
      req: ExtendedRequest,
      res: Response,
      _next: NextFunction,
      opts: Options
    ): void => {
      const key = req.session?.userId || ipKeyGenerator(req.ip || '0.0.0.0');
      logger.warn(
        { type: 'rate_limit', action: actionName, key, limit: max, windowMs },
        `Rate limit exceeded for ${actionName}: ${key}`
      );
      rateLimitHits.labels(actionName).inc();

      const errorMessage =
        typeof opts.message === 'object' && opts.message !== null && 'error' in opts.message
          ? (opts.message as { error: string }).error
          : message;
      res.status(opts.statusCode || 429).json({ error: errorMessage });
    },
  });
};

/** Rate limiter for drawing creation operations, 30 per hour. */
export const drawingRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'drawings',
  max: 30,
  windowMs: 60 * 60 * 1000,
  message: 'Too many drawing operations. Please wait.',
  actionName: 'drawing_create',
});

/** Rate limiter for login attempts, 5 per minute with successful request skipping. */
export const loginRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'login',
  max: 5,
  windowMs: 60 * 1000,
  message: 'Too many login attempts. Please try again later.',
  skipSuccessfulRequests: true,
  actionName: 'login',
});

/** General API rate limiter, 1000 requests per minute. */
export const generalRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'general',
  max: 1000,
  windowMs: 60 * 1000,
  message: 'Too many requests. Please slow down.',
  actionName: 'general',
});

export default {
  drawingRateLimiter,
  loginRateLimiter,
  generalRateLimiter,
};
