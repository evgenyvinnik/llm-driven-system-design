import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createLogger } from './logger.js';
import { rateLimitHitsCounter } from './metrics.js';

const logger = createLogger('rate-limiter');

/**
 * Create a Redis-backed rate limiter
 */
export const createRateLimiter = (redisClient, options = {}) => {
  const {
    windowMs = 60000,           // 1 minute default
    max = 100,                   // 100 requests per window default
    message = 'Too many requests, please try again later',
    prefix = 'rl:',
    keyGenerator = null,
    skipFailedRequests = false,
    skipSuccessfulRequests = false,
    standardHeaders = true,
    legacyHeaders = false,
  } = options;

  return rateLimit({
    store: new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix,
    }),
    windowMs,
    max,
    message: { error: message },
    standardHeaders,
    legacyHeaders,
    skipFailedRequests,
    skipSuccessfulRequests,
    keyGenerator: keyGenerator || ((req) => {
      // Use user ID if authenticated, otherwise use IP
      return req.session?.userId
        ? `user:${req.session.userId}`
        : `ip:${req.ip || req.connection?.remoteAddress}`;
    }),
    handler: (req, res, next, optionsUsed) => {
      // Log rate limit hit
      const userType = req.session?.userId ? 'authenticated' : 'anonymous';
      const endpoint = options.endpointName || req.path;

      logger.warn({
        endpoint,
        userType,
        userId: req.session?.userId,
        ip: req.ip,
        limit: optionsUsed.max,
        windowMs: optionsUsed.windowMs,
      }, 'Rate limit exceeded');

      // Record metric
      rateLimitHitsCounter.labels(endpoint, userType).inc();

      res.status(429).json({
        error: message,
        retryAfter: Math.ceil(optionsUsed.windowMs / 1000),
      });
    },
  });
};

/**
 * Pre-configured rate limiters for different endpoints
 */
export const createRateLimiters = (redisClient) => {
  return {
    // Video upload - strict limit (10/hour)
    // WHY: Video processing is CPU-intensive and uses expensive storage
    upload: createRateLimiter(redisClient, {
      windowMs: 60 * 60 * 1000,     // 1 hour
      max: 10,
      message: 'Upload limit reached. You can upload up to 10 videos per hour.',
      prefix: 'rl:upload:',
      endpointName: 'video_upload',
    }),

    // Comments - moderate limit (30/minute)
    // WHY: Prevent comment spam and flooding
    comment: createRateLimiter(redisClient, {
      windowMs: 60 * 1000,           // 1 minute
      max: 30,
      message: 'Comment limit reached. Please slow down.',
      prefix: 'rl:comment:',
      endpointName: 'comment',
    }),

    // Likes - moderate limit (100/minute)
    // WHY: Prevent like manipulation and bot activity
    like: createRateLimiter(redisClient, {
      windowMs: 60 * 1000,           // 1 minute
      max: 100,
      message: 'Like limit reached. Please slow down.',
      prefix: 'rl:like:',
      endpointName: 'like',
    }),

    // Feed requests - generous limit (60/minute)
    // WHY: Normal scrolling behavior, but prevent scraping
    feed: createRateLimiter(redisClient, {
      windowMs: 60 * 1000,           // 1 minute
      max: 60,
      message: 'Too many feed requests. Please slow down.',
      prefix: 'rl:feed:',
      endpointName: 'feed',
    }),

    // Search - moderate limit (30/minute)
    // WHY: Prevent scraping and excessive search queries
    search: createRateLimiter(redisClient, {
      windowMs: 60 * 1000,           // 1 minute
      max: 30,
      message: 'Search limit reached. Please slow down.',
      prefix: 'rl:search:',
      endpointName: 'search',
    }),

    // Login attempts - strict limit (5/15 minutes)
    // WHY: Brute-force protection
    login: createRateLimiter(redisClient, {
      windowMs: 15 * 60 * 1000,      // 15 minutes
      max: 5,
      message: 'Too many login attempts. Please try again in 15 minutes.',
      prefix: 'rl:login:',
      keyGenerator: (req) => `ip:${req.ip || req.connection?.remoteAddress}`,
      endpointName: 'login',
    }),

    // Registration - strict limit (3/hour per IP)
    // WHY: Prevent mass account creation
    register: createRateLimiter(redisClient, {
      windowMs: 60 * 60 * 1000,      // 1 hour
      max: 3,
      message: 'Too many registration attempts. Please try again later.',
      prefix: 'rl:register:',
      keyGenerator: (req) => `ip:${req.ip || req.connection?.remoteAddress}`,
      endpointName: 'register',
    }),

    // Follow actions - moderate limit (50/minute)
    // WHY: Prevent follow/unfollow spam
    follow: createRateLimiter(redisClient, {
      windowMs: 60 * 1000,           // 1 minute
      max: 50,
      message: 'Follow limit reached. Please slow down.',
      prefix: 'rl:follow:',
      endpointName: 'follow',
    }),

    // Admin API - higher limit (100/minute)
    // WHY: Ops work needs higher limits but still protected
    admin: createRateLimiter(redisClient, {
      windowMs: 60 * 1000,           // 1 minute
      max: 100,
      message: 'Admin API rate limit reached.',
      prefix: 'rl:admin:',
      endpointName: 'admin',
    }),

    // General API - default catch-all (200/minute)
    general: createRateLimiter(redisClient, {
      windowMs: 60 * 1000,           // 1 minute
      max: 200,
      message: 'Rate limit exceeded. Please slow down.',
      prefix: 'rl:general:',
      endpointName: 'general',
    }),
  };
};

/**
 * Role-based rate limit multipliers
 * Verified/premium users get higher limits
 */
export const getRateLimitMultiplier = (role) => {
  const multipliers = {
    user: 1.0,
    creator: 1.5,      // Creators get 50% more capacity
    moderator: 2.0,    // Moderators get 2x capacity
    admin: 5.0,        // Admins get 5x capacity
  };
  return multipliers[role] || 1.0;
};

/**
 * Dynamic rate limiter that adjusts limits based on user role
 */
export const createDynamicRateLimiter = (redisClient, baseOptions = {}) => {
  return (req, res, next) => {
    const multiplier = getRateLimitMultiplier(req.session?.role);
    const adjustedMax = Math.floor((baseOptions.max || 100) * multiplier);

    const limiter = createRateLimiter(redisClient, {
      ...baseOptions,
      max: adjustedMax,
    });

    return limiter(req, res, next);
  };
};

export default {
  createRateLimiter,
  createRateLimiters,
  getRateLimitMultiplier,
  createDynamicRateLimiter,
};
