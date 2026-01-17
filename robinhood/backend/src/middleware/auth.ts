import { Request, Response, NextFunction } from 'express';
import { pool } from '../database.js';
import { redis } from '../redis.js';
import { logger } from '../shared/logger.js';
import type { User } from '../types/index.js';

/** Session cache TTL in Redis (1 hour) */
const SESSION_CACHE_TTL = 60 * 60;

/** Session cache key prefix */
const SESSION_CACHE_PREFIX = 'session_cache:';

/**
 * Extended Express Request with authenticated user information.
 * Populated by authMiddleware after successful token validation.
 */
export interface AuthenticatedRequest extends Request {
  user?: User;
  /** Request ID for tracing */
  requestId?: string;
}

/**
 * Cached user data for session validation.
 */
interface CachedSession {
  user: User;
  expiresAt: number;
}

/**
 * Express middleware that validates Bearer token authentication.
 * Verifies the token against active sessions in the database and
 * attaches the authenticated user to the request object.
 *
 * Performance optimization: Uses Redis to cache session lookups
 * to reduce database load. Cache is invalidated on logout.
 *
 * Returns 401 if token is missing, invalid, or expired.
 * @param req - Express request with authorization header
 * @param res - Express response for sending error responses
 * @param next - Express next function to continue middleware chain
 */
export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const requestId = req.headers['x-request-id'] as string | undefined;
  req.requestId = requestId;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided', requestId });
    return;
  }

  const token = authHeader.substring(7);

  try {
    // Try to get from cache first
    const cacheKey = `${SESSION_CACHE_PREFIX}${token}`;
    const cachedData = await redis.get(cacheKey);

    if (cachedData) {
      try {
        const cached: CachedSession = JSON.parse(cachedData);

        // Check if cached session is still valid
        if (cached.expiresAt > Date.now()) {
          req.user = cached.user;
          logger.debug({ userId: cached.user.id, requestId }, 'Session loaded from cache');
          next();
          return;
        } else {
          // Cache expired, delete it
          await redis.del(cacheKey);
        }
      } catch (parseError) {
        // Invalid cache data, delete it
        await redis.del(cacheKey);
      }
    }

    // Cache miss or expired - query database
    const result = await pool.query(
      `SELECT u.*, s.expires_at as session_expires_at
       FROM users u
       INNER JOIN sessions s ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      logger.debug({ token: token.substring(0, 8) + '...', requestId }, 'Invalid or expired token');
      res.status(401).json({ error: 'Invalid or expired token', requestId });
      return;
    }

    const row = result.rows[0];
    const user: User = {
      id: row.id,
      email: row.email,
      password_hash: row.password_hash,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      account_status: row.account_status,
      buying_power: parseFloat(row.buying_power),
      role: row.role,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    // Cache the session for future requests
    const sessionExpiresAt = new Date(row.session_expires_at).getTime();
    const cached: CachedSession = {
      user,
      expiresAt: sessionExpiresAt,
    };

    // Set cache with TTL that doesn't exceed session expiry
    const ttl = Math.min(SESSION_CACHE_TTL, Math.floor((sessionExpiresAt - Date.now()) / 1000));
    if (ttl > 0) {
      await redis.set(cacheKey, JSON.stringify(cached), 'EX', ttl);
    }

    req.user = user;
    logger.debug({ userId: user.id, requestId }, 'Session validated from database');
    next();
  } catch (error) {
    logger.error({ error, requestId }, 'Auth middleware error');
    res.status(500).json({ error: 'Authentication failed', requestId });
  }
}

/**
 * Express middleware that restricts access to admin users only.
 * Must be used after authMiddleware to ensure user is authenticated.
 * Returns 403 if the authenticated user does not have admin role.
 * @param req - Authenticated request with user object
 * @param res - Express response for sending error responses
 * @param next - Express next function to continue middleware chain
 */
export function adminMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const requestId = req.requestId;

  if (!req.user || req.user.role !== 'admin') {
    logger.warn({ userId: req.user?.id, requestId }, 'Admin access denied');
    res.status(403).json({ error: 'Admin access required', requestId });
    return;
  }
  next();
}

/**
 * Invalidates the session cache for a token.
 * Should be called on logout to ensure the session is immediately invalidated.
 * @param token - Session token to invalidate
 */
export async function invalidateSessionCache(token: string): Promise<void> {
  const cacheKey = `${SESSION_CACHE_PREFIX}${token}`;
  await redis.del(cacheKey);
  logger.debug({ token: token.substring(0, 8) + '...' }, 'Session cache invalidated');
}

/**
 * Optional middleware that requires a valid account status.
 * Blocks suspended or closed accounts from accessing the API.
 * @param req - Authenticated request with user object
 * @param res - Express response for sending error responses
 * @param next - Express next function to continue middleware chain
 */
export function activeAccountMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const requestId = req.requestId;

  if (!req.user) {
    res.status(401).json({ error: 'Authentication required', requestId });
    return;
  }

  if (req.user.account_status !== 'active') {
    logger.warn(
      { userId: req.user.id, accountStatus: req.user.account_status, requestId },
      'Account not active'
    );
    res.status(403).json({
      error: `Account is ${req.user.account_status}. Please contact support.`,
      requestId,
    });
    return;
  }

  next();
}
