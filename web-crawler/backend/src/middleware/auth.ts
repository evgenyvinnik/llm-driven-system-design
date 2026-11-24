/**
 * @fileoverview Authentication middleware with Redis-backed sessions.
 *
 * Implements session-based authentication for the web crawler admin interface.
 * Uses Redis for session storage to enable distributed session management
 * across multiple API server instances.
 *
 * This approach is simpler than JWT/OAuth for a learning project while still
 * demonstrating proper authentication patterns.
 *
 * @module middleware/auth
 */

import session from 'express-session';
// connect-redis v7: supports the ioredis client. (v9 targets node-redis v5's
// `set(key, val, { EX })` signature; with ioredis every session write failed
// with 'ERR syntax error', so no admin session was ever persisted.)
import RedisStore from 'connect-redis';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { redis } from '../models/redis.js';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';

/**
 * User roles for RBAC.
 */
export enum UserRole {
  /** Can view public stats and health endpoints */
  ANONYMOUS = 'anonymous',
  /** Can view all data, no modifications */
  USER = 'user',
  /** Full access including modifications */
  ADMIN = 'admin',
}

/**
 * Session data stored in Redis.
 */
export interface SessionData {
  userId?: string;
  username?: string;
  role?: UserRole;
  createdAt?: number;
}

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    username?: string;
    role?: UserRole;
    createdAt?: number;
  }
}

/**
 * Creates the session middleware with Redis store.
 *
 * @returns Express session middleware configured for Redis
 */
/** Development fallback; refusing it in production is enforced below. */
const DEV_SESSION_SECRET = 'dev-secret-change-in-production';

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
 * Admin credentials storage.
 * In production, this would be stored in a database with proper password hashing.
 * For this learning project, we use a simple in-memory store.
 */
interface AdminCredentials {
  username: string;
  passwordHash: string;
  salt: string;
  role: UserRole;
}

// Default admin credentials (in real app, would be in database)
const adminCredentials: Map<string, AdminCredentials> = new Map();

/** PBKDF2 iterations (OWASP 2023 guidance for PBKDF2-HMAC-SHA512). */
const PBKDF2_ITERATIONS = 210_000;

/**
 * Initializes the admin account from the environment.
 *
 * Credentials come from ADMIN_USERNAME / ADMIN_PASSWORD, defaulting to the
 * repository's standard development credentials (admin / password123). In
 * production, the default password is refused.
 */
export function initializeDefaultAdmin(): void {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'password123';

  if (config.nodeEnv === 'production' && !process.env.ADMIN_PASSWORD) {
    throw new Error('ADMIN_PASSWORD must be set in production');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  adminCredentials.set(username, {
    username,
    passwordHash: hashPassword(password, salt),
    salt,
    role: UserRole.ADMIN,
  });

  logger.info({ username }, 'Admin user initialized');
}

/**
 * Hashes a password with PBKDF2-HMAC-SHA512.
 */
function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
}

/** Salt used to burn the same CPU for unknown usernames (no user-enumeration timing). */
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

/**
 * Validates username and password against stored credentials.
 *
 * - Compares hashes with crypto.timingSafeEqual (no early-exit string compare)
 * - Hashes even when the username is unknown, so response time doesn't reveal
 *   which usernames exist
 *
 * @returns User info if valid, null otherwise
 */
export function validateCredentials(
  username: string,
  password: string
): { userId: string; username: string; role: UserRole } | null {
  const user = adminCredentials.get(username);
  const hash = hashPassword(password, user?.salt ?? DUMMY_SALT);
  if (!user) return null;

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return {
    userId: username, // Using username as ID for simplicity
    username: user.username,
    role: user.role,
  };
}

/**
 * Middleware to authenticate requests using session.
 * Populates req.session with user data if authenticated.
 * Does NOT reject unauthenticated requests - use requireAuth for that.
 */
export function authenticateSession(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  // Session middleware has already populated req.session
  // Just log and continue
  if (req.session?.userId) {
    logger.debug(
      { userId: req.session.userId, role: req.session.role },
      'Authenticated request'
    );
  }
  next();
}

/**
 * Middleware that requires authentication.
 * Returns 401 if not authenticated.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.session?.userId) {
    res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource',
    });
    return;
  }
  next();
}

/**
 * Middleware that requires specific roles (RBAC).
 *
 * @param allowedRoles - Array of roles that can access this resource
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * // Only admins can access
 * router.post('/admin/action', requireRole([UserRole.ADMIN]), handler);
 *
 * // Users and admins can access
 * router.get('/data', requireRole([UserRole.USER, UserRole.ADMIN]), handler);
 * ```
 */
export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Check if authenticated
    if (!req.session?.userId) {
      res.status(401).json({
        error: 'Authentication required',
        message: 'Please log in to access this resource',
      });
      return;
    }

    // Check if role is allowed
    const userRole = req.session.role || UserRole.ANONYMOUS;
    if (!allowedRoles.includes(userRole)) {
      logger.warn(
        { userId: req.session.userId, role: userRole, required: allowedRoles },
        'Access denied - insufficient permissions'
      );
      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to access this resource',
      });
      return;
    }

    next();
  };
}

/**
 * Login request body.
 */
export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * Login handler.
 * Validates credentials and creates session.
 */
export async function loginHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { username, password } = (req.body ?? {}) as LoginRequest;

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Username and password are required',
    });
    return;
  }

  const user = validateCredentials(username, password);
  if (!user) {
    logger.warn({ username }, 'Failed login attempt');
    res.status(401).json({
      error: 'Invalid credentials',
      message: 'Username or password is incorrect',
    });
    return;
  }

  // Issue a fresh session ID on privilege change, so a session ID planted
  // before login (session fixation) can't be used to ride the admin session.
  req.session.regenerate((err) => {
    if (err) {
      logger.error({ err }, 'Failed to regenerate session');
      res.status(500).json({ error: 'Login failed' });
      return;
    }

    req.session.userId = user.userId;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.createdAt = Date.now();

    logger.info({ userId: user.userId, role: user.role }, 'User logged in');

    res.json({
      message: 'Login successful',
      user: {
        username: user.username,
        role: user.role,
      },
    });
  });
}

/**
 * Logout handler.
 * Destroys session.
 */
export async function logoutHandler(
  req: Request,
  res: Response
): Promise<void> {
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
 * Get current user handler.
 * Returns current session info.
 */
export function getCurrentUser(req: Request, res: Response): void {
  if (!req.session?.userId) {
    res.json({
      authenticated: false,
      user: null,
    });
    return;
  }

  res.json({
    authenticated: true,
    user: {
      userId: req.session.userId,
      username: req.session.username,
      role: req.session.role,
      createdAt: req.session.createdAt,
    },
  });
}

/**
 * Shorthand for routes that change crawler state: admin role required.
 * Read-only routes stay public so the dashboard is viewable without login.
 */
export const requireAdmin = requireRole([UserRole.ADMIN]);
