import rateLimit from 'express-rate-limit';

/** General API rate limiter allowing 1000 requests per 15-minute window. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

/** Authentication rate limiter allowing 50 attempts per 15-minute window. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

/**
 * Report rate limiter: 60 requests per minute per signed-in user.
 *
 * It runs after requireAuth, so it keys on the session's user rather than the
 * IP. Keyed by IP at 30/min, everyone behind one NAT or proxy shared a single
 * budget, and since the dashboard itself calls /reports/pipeline, a few
 * dashboard/reports round trips (doubled by React StrictMode in dev) used it
 * up; the 429s then rendered as empty "No data" charts.
 */
export const reportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session?.userId ?? req.ip ?? 'anonymous',
  message: { error: 'Too many report requests, please try again later.' },
});
