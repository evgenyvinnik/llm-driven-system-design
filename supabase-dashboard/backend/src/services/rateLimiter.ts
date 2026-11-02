import rateLimit from 'express-rate-limit';
import '../middleware/auth.js'; // session typing (userId)

/** General API rate limiter allowing 1000 requests per 15-minute window. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

/** Auth endpoint rate limiter allowing 50 attempts per 15-minute window. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

/**
 * SQL query rate limiter allowing 100 executions per minute per user. It runs
 * after requireAuth, so the session identifies the caller; keying by IP would
 * let users behind one NAT exhaust each other's budget.
 */
export const queryLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  keyGenerator: (req) => (req.session?.userId ? `user:${req.session.userId}` : `ip:${req.ip}`),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many query executions, please try again later.' },
});
