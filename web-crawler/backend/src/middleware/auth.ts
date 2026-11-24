/**
 * @fileoverview Authentication middleware with Redis-backed sessions.
 *
 * Session-based auth for the crawler dashboard:
 * - Accounts live in the PostgreSQL `users` table (`services/users.ts`)
 * - Sessions live in Redis (connect-redis) and record the user's id, role and
 *   the `session_version` they were issued with
 * - Every route that needs auth re-reads the user by primary key and rejects
 *   the session if the user was deleted, disabled, or their version changed
 *   (role change, password change), so revocation is immediate
 *
 * Simpler than JWT/OAuth for a learning project, and unlike stateless tokens,
 * revocation needs no denylist.
 *
 * @module middleware/auth
 */

import session from 'express-session';
// connect-redis v7: supports the ioredis client. (v9 targets node-redis v5's
// `set(key, val, { EX })` signature; with ioredis every session write failed
// with 'ERR syntax error', so no admin session was ever persisted.)
import RedisStore from 'connect-redis';
import { Request, Response, NextFunction } from 'express';
import { redis } from '../models/redis.js';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';
import * as users from '../services/users.js';

/**
 * User roles for RBAC.
 */
export enum UserRole {
  /** Not signed in: read-only access to public endpoints */
  ANONYMOUS = 'anonymous',
  /** Signed-in read-only operator */
  USER = 'user',
  /** Can change crawler state and manage users */
  ADMIN = 'admin',
}

declare module 'express-session' {
  interface SessionData {
    /** users.id, as a string */
    userId?: string;
    username?: string;
    role?: UserRole;
    /** users.session_version at login; a mismatch means the session was revoked */
    sessionVersion?: number;
    createdAt?: number;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    /** The verified current user, set by requireAuth / requireRole */
    user?: users.User;
  }
}

/** Development fallback; refusing it in production is enforced below. */
const DEV_SESSION_SECRET = 'dev-secret-change-in-production';

/**
 * Creates the Redis-backed session middleware.
 */
export function createSessionMiddleware() {
  const secret = process.env.SESSION_SECRET || DEV_SESSION_SECRET;
  if (config.nodeEnv === 'production' && secret === DEV_SESSION_SECRET) {
    // A known secret lets anyone forge a signed admin session cookie.
    throw new Error('SESSION_SECRET must be set in production');
  }

  const redisStore = new RedisStore({
    client: redis,
    prefix: 'crawler:session:',
    ttl: 24 * 60 * 60, // 24 hours
  });

  return session({
    store: redisStore,
    secret,
    resave: false,
    saveUninitialized: false,
    name: 'crawler.sid',
    cookie: {
      // Secure cookies by default in production. express-session silently
      // refuses to set a Secure cookie on a plain-HTTP request, so a deployment
      // that terminates TLS at a proxy must set TRUST_PROXY=1, and a local
      // HTTP-only setup (docker-compose) sets COOKIE_SECURE=false.
      secure:
        process.env.COOKIE_SECURE !== undefined
          ? process.env.COOKIE_SECURE === 'true'
          : config.nodeEnv === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'strict',
    },
  });
}

/**
 * Loads and verifies the session's user. Returns null (and destroys the
 * session) if the user is gone, disabled, or the session was revoked.
 */
async function loadSessionUser(req: Request): Promise<users.User | null> {
  const id = Number(req.session?.userId);
  if (!id) return null;

  const user = await users.getUserById(id);
  if (!user || user.disabled || user.sessionVersion !== req.session.sessionVersion) {
    logger.info({ userId: id }, 'Rejected revoked or stale session');
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    return null;
  }
  return user;
}

function unauthenticated(res: Response): void {
  res.status(401).json({
    error: 'Authentication required',
    message: 'Please log in to access this resource',
  });
}

/**
 * Requires a valid signed-in user of any role.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await loadSessionUser(req);
    if (!user) return unauthenticated(res);
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Requires a valid signed-in user whose *current* role (from the database,
 * not the session) is one of `allowedRoles`.
 */
export function requireRole(allowedRoles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await loadSessionUser(req);
      if (!user) return unauthenticated(res);

      if (!allowedRoles.includes(user.role as UserRole)) {
        logger.warn(
          { userId: user.id, role: user.role, required: allowedRoles },
          'Access denied - insufficient permissions'
        );
        res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have permission to access this resource',
        });
        return;
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Shorthand for routes that change crawler state: admin role required.
 * Read-only routes stay public so the dashboard is viewable without login.
 */
export const requireAdmin = requireRole([UserRole.ADMIN]);

/**
 * Writes the authenticated user into a freshly regenerated session.
 */
function startSession(req: Request, user: users.User): Promise<void> {
  return new Promise((resolve, reject) => {
    // A fresh session ID on privilege change, so a session ID planted before
    // login (session fixation) can't be used to ride the new session.
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = String(user.id);
      req.session.username = user.username;
      req.session.role = user.role as UserRole;
      req.session.sessionVersion = user.sessionVersion;
      req.session.createdAt = Date.now();
      resolve();
    });
  });
}

function publicUser(user: users.User) {
  return { id: user.id, username: user.username, role: user.role };
}

/**
 * POST /api/auth/login
 */
export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body ?? {};

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'Bad Request', message: 'Username and password are required' });
    return;
  }

  try {
    const user = await users.authenticate(username, password);
    if (!user) {
      logger.warn({ username }, 'Failed login attempt');
      res.status(401).json({
        error: 'Invalid credentials',
        message: 'Username or password is incorrect',
      });
      return;
    }

    await startSession(req, user);
    logger.info({ userId: user.id, role: user.role }, 'User logged in');
    res.json({ message: 'Login successful', user: publicUser(user) });
  } catch (error) {
    logger.error({ err: error }, 'Login failed');
    res.status(500).json({ error: 'Login failed' });
  }
}

/**
 * POST /api/auth/logout
 */
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  const userId = req.session?.userId;

  req.session.destroy((err) => {
    if (err) {
      logger.error({ err }, 'Failed to destroy session');
      res.status(500).json({ error: 'Failed to logout' });
      return;
    }

    logger.info({ userId }, 'User logged out');
    res.clearCookie('crawler.sid');
    res.json({ message: 'Logout successful' });
  });
}

/**
 * GET /api/auth/me - verified against the database, so a revoked session
 * reports signed-out rather than echoing stale session data.
 */
export async function getCurrentUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await loadSessionUser(req);
    res.json(user ? { authenticated: true, user: publicUser(user) } : { authenticated: false, user: null });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/password - change your own password (requireAuth first).
 *
 * Bumps session_version, which revokes the user's *other* sessions; this
 * session is re-issued with the new version so the user stays signed in here.
 */
export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    const updated = await users.changeOwnPassword(req.user!.id, currentPassword, newPassword);
    await startSession(req, updated);
    logger.info({ userId: updated.id }, 'Password changed');
    res.json({ message: 'Password changed. Other sessions were signed out.' });
  } catch (error) {
    if (error instanceof users.UserError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, 'Password change failed');
    res.status(500).json({ error: 'Password change failed' });
  }
}
