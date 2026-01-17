import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { logger, auditLog } from '../shared/logger.js';
import { authAttempts, cacheHits } from '../shared/metrics.js';

/**
 * Authentication and Authorization middleware.
 *
 * Implements:
 * - Session-based authentication with Redis caching
 * - Role-Based Access Control (RBAC)
 * - Permission checks for granular authorization
 *
 * Session flow:
 * 1. Client sends session_token cookie or Authorization header
 * 2. Check Redis cache for session data
 * 3. Fallback to PostgreSQL if not cached
 * 4. Cache session in Redis for 1 hour
 *
 * Trade-off: Session vs JWT
 * - Sessions: Easier revocation, server-side state
 * - JWT: Stateless, better for microservices
 * Chosen: Sessions for simpler local development and instant revocation
 */

/**
 * RBAC permission definitions.
 * Maps roles to their allowed permissions.
 */
const ROLE_PERMISSIONS = {
  user: [
    'catalog:read',
    'library:own',
    'stream:basic',
    'history:own',
    'playlist:own'
  ],
  premium_user: [
    'catalog:read',
    'library:own',
    'stream:lossless',
    'stream:download',
    'history:own',
    'playlist:own'
  ],
  curator: [
    'catalog:read',
    'library:own',
    'stream:basic',
    'history:own',
    'playlist:own',
    'playlist:public',
    'content:feature'
  ],
  admin: ['*'] // Wildcard - all permissions
};

/**
 * Main authentication middleware.
 * Validates session and attaches user to request.
 */
export async function authenticate(req, res, next) {
  try {
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      authAttempts.inc({ type: 'session', result: 'missing_token' });
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check Redis cache first
    const cacheKey = `session:${token}`;
    const sessionData = await redis.get(cacheKey);

    if (sessionData) {
      cacheHits.inc({ cache: 'session', result: 'hit' });
      req.user = JSON.parse(sessionData);
      req.user.id = req.user.userId;
      req.sessionToken = token;
      return next();
    }

    cacheHits.inc({ cache: 'session', result: 'miss' });

    // Fallback to database
    const result = await pool.query(
      `SELECT s.*, u.id as user_id, u.email, u.username, u.display_name, u.role,
              u.subscription_tier, u.preferred_quality
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      authAttempts.inc({ type: 'session', result: 'invalid' });
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const session = result.rows[0];
    const userData = {
      userId: session.user_id,
      email: session.email,
      username: session.username,
      displayName: session.display_name,
      role: session.role || 'user',
      subscriptionTier: session.subscription_tier || 'free',
      preferredQuality: session.preferred_quality || '256_aac'
    };

    // Cache in Redis for 1 hour
    await redis.setex(cacheKey, 3600, JSON.stringify(userData));

    req.user = {
      ...userData,
      id: session.user_id
    };
    req.sessionToken = token;

    authAttempts.inc({ type: 'session', result: 'success' });
    next();
  } catch (error) {
    logger.error({ err: error }, 'Auth middleware error');
    authAttempts.inc({ type: 'session', result: 'error' });
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional authentication middleware.
 * Attaches user if session exists, continues otherwise.
 */
export async function optionalAuth(req, res, next) {
  try {
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const sessionData = await redis.get(`session:${token}`);

      if (sessionData) {
        req.user = JSON.parse(sessionData);
        req.user.id = req.user.userId;
        cacheHits.inc({ cache: 'session', result: 'hit' });
      } else {
        cacheHits.inc({ cache: 'session', result: 'miss' });
      }
    }

    next();
  } catch (error) {
    // Continue without auth on error
    logger.warn({ err: error }, 'Optional auth check failed');
    next();
  }
}

/**
 * Admin role requirement middleware.
 * Must be used after authenticate middleware.
 */
export async function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    logger.warn({
      userId: req.user?.id,
      attemptedRole: 'admin',
      actualRole: req.user?.role
    }, 'Admin access denied');
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Permission-based authorization middleware.
 * Checks if user has required permission based on their role.
 *
 * Usage:
 * router.post('/playlists/public', authenticate, requirePermission('playlist:public'), handler);
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const role = req.user.role || 'user';
    const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.user;

    // Check for wildcard or specific permission
    if (permissions.includes('*') || permissions.includes(permission)) {
      return next();
    }

    logger.warn({
      userId: req.user.id,
      role,
      requiredPermission: permission,
      path: req.path
    }, 'Permission denied');

    res.status(403).json({
      error: 'Insufficient permissions',
      required: permission
    });
  };
}

/**
 * Check if user has a specific permission.
 * Utility function for conditional logic in handlers.
 */
export function hasPermission(user, permission) {
  if (!user) return false;

  const role = user.role || 'user';
  const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.user;

  return permissions.includes('*') || permissions.includes(permission);
}

/**
 * Subscription tier check middleware.
 * Verifies user has required subscription level.
 */
export function requireSubscription(minTier) {
  const tierOrder = ['free', 'student', 'individual', 'family'];

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userTierIndex = tierOrder.indexOf(req.user.subscriptionTier || 'free');
    const requiredTierIndex = tierOrder.indexOf(minTier);

    if (userTierIndex < requiredTierIndex) {
      return res.status(403).json({
        error: 'Subscription upgrade required',
        currentTier: req.user.subscriptionTier,
        requiredTier: minTier
      });
    }

    next();
  };
}

/**
 * Invalidate session in cache and database.
 * Used for logout and session revocation.
 */
export async function invalidateSession(token) {
  try {
    // Remove from Redis cache
    await redis.del(`session:${token}`);

    // Mark as expired in database
    await pool.query(
      'UPDATE sessions SET expires_at = NOW() WHERE token = $1',
      [token]
    );

    logger.info({ token: token.substring(0, 8) + '...' }, 'Session invalidated');
    return true;
  } catch (err) {
    logger.error({ err }, 'Session invalidation failed');
    return false;
  }
}

/**
 * Audit-logged authentication for sensitive operations.
 * Combines authenticate with audit logging.
 */
export function authenticateWithAudit(action) {
  return [authenticate, auditLog(action)];
}

export default {
  authenticate,
  optionalAuth,
  requireAdmin,
  requirePermission,
  hasPermission,
  requireSubscription,
  invalidateSession,
  authenticateWithAudit,
  ROLE_PERMISSIONS
};
