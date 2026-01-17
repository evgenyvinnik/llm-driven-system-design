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
export function createSessionMiddleware() {
  const redisStore = new RedisStore({
    client: redis,
    prefix: 'crawler:session:',
    ttl: 24 * 60 * 60, // 24 hours
  });

  return session({
    store: redisStore,
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'crawler.sid',
    cookie: {
      secure: config.nodeEnv === 'production',
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

/**
 * Initializes default admin user.
 * Password is 'admin' - change in production!
 */
export function initializeDefaultAdmin(): void {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto
    .pbkdf2Sync('admin', salt, 1000, 64, 'sha512')
    .toString('hex');

  adminCredentials.set('admin', {
    username: 'admin',
    passwordHash,
    salt,
    role: UserRole.ADMIN,
  });

  logger.info('Default admin user initialized (username: admin, password: admin)');
}

/**
 * Hashes a password with the given salt.
 */
function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

/**
 * Validates credentials and returns user info if valid.
 */
export function validateCredentials(
  username: string,
  password: string
): { userId: string; username: string; role: UserRole } | null {
  const user = adminCredentials.get(username);
  if (!user) return null;

  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) return null;

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
  const { username, password } = req.body as LoginRequest;

  if (!username || !password) {
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

  // Create session
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
