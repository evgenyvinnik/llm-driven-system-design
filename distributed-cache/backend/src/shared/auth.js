/**
 * Admin Authentication Middleware
 *
 * Provides API key authentication for admin endpoints.
 * Features:
 * - API key validation via header
 * - Rate limiting for admin endpoints
 * - Audit logging of admin operations
 */

import { logAdminAuthFailure, adminLogger } from './logger.js';

// Configuration from environment
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const ADMIN_KEY_HEADER = process.env.ADMIN_KEY_HEADER || 'x-admin-key';

// Rate limiting state
const rateLimitState = new Map();
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.ADMIN_RATE_LIMIT_WINDOW_MS || '60000',
  10
);
const RATE_LIMIT_MAX_REQUESTS = parseInt(
  process.env.ADMIN_RATE_LIMIT_MAX || '10',
  10
);

/**
 * Check if an IP is rate limited
 * @param {string} ip
 * @returns {boolean}
 */
function isRateLimited(ip) {
  const now = Date.now();
  const state = rateLimitState.get(ip);

  if (!state) {
    rateLimitState.set(ip, { count: 1, windowStart: now });
    return false;
  }

  // Reset window if expired
  if (now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(ip, { count: 1, windowStart: now });
    return false;
  }

  // Increment count
  state.count++;

  if (state.count > RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  return false;
}

/**
 * Clean up old rate limit entries periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of rateLimitState) {
    if (now - state.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitState.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

/**
 * Middleware to require admin authentication
 * Validates X-Admin-Key header against configured admin key
 */
export function requireAdminKey(req, res, next) {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const endpoint = `${req.method} ${req.path}`;

  // Check rate limit first
  if (isRateLimited(clientIp)) {
    adminLogger.warn(
      { ip: clientIp, endpoint },
      'admin_rate_limit_exceeded'
    );
    return res.status(429).json({
      error: 'Too many admin requests',
      message: `Rate limit exceeded. Max ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW_MS / 1000} seconds.`,
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  }

  const providedKey = req.headers[ADMIN_KEY_HEADER.toLowerCase()];

  if (!providedKey) {
    logAdminAuthFailure(clientIp, endpoint);
    return res.status(401).json({
      error: 'Unauthorized',
      message: `Missing ${ADMIN_KEY_HEADER} header`,
    });
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(providedKey, ADMIN_KEY)) {
    logAdminAuthFailure(clientIp, endpoint);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid admin key',
    });
  }

  // Log successful admin access
  adminLogger.info(
    { ip: clientIp, endpoint },
    'admin_auth_success'
  );

  next();
}

/**
 * Constant-time string comparison to prevent timing attacks
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const lenA = a.length;
  const lenB = b.length;
  const len = Math.max(lenA, lenB);

  let result = lenA === lenB ? 0 : 1;

  for (let i = 0; i < len; i++) {
    const charA = i < lenA ? a.charCodeAt(i) : 0;
    const charB = i < lenB ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  return result === 0;
}

/**
 * Optional middleware for read-only admin operations (GET endpoints)
 * Less strict - just logs the access without requiring auth
 * Can be enabled for debugging/monitoring endpoints
 */
export function logAdminAccess(req, res, next) {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const endpoint = `${req.method} ${req.path}`;

  adminLogger.debug({ ip: clientIp, endpoint }, 'admin_endpoint_accessed');

  next();
}

/**
 * Get admin key configuration (for documentation purposes)
 * Does not expose the actual key
 */
export function getAdminConfig() {
  return {
    headerName: ADMIN_KEY_HEADER,
    keyConfigured: ADMIN_KEY !== 'dev-admin-key',
    rateLimitWindow: RATE_LIMIT_WINDOW_MS,
    rateLimitMax: RATE_LIMIT_MAX_REQUESTS,
  };
}

export default {
  requireAdminKey,
  logAdminAccess,
  getAdminConfig,
};
