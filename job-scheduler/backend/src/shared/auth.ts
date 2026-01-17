/**
 * Authentication and authorization module for the job scheduler.
 * Implements session-based authentication with Redis storage
 * and role-based access control (RBAC) for user vs admin operations.
 * @module shared/auth
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { redis } from '../queue/redis';
import { logger } from '../utils/logger';

/** Session TTL in seconds (24 hours) */
const SESSION_TTL = 86400;

/** Redis key prefix for sessions */
const SESSION_PREFIX = 'job_scheduler:session:';

/** Redis key prefix for users */
const USER_PREFIX = 'job_scheduler:user:';

/**
 * User roles for RBAC.
 * - user: Can view jobs and executions, trigger own jobs
 * - admin: Full access to all operations
 */
export type UserRole = 'user' | 'admin';

/**
 * User record stored in Redis.
 */
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: number;
}

/**
 * Session data stored in Redis.
 */
export interface Session {
  userId: string;
  username: string;
  role: UserRole;
  createdAt: number;
  lastActivity: number;
}

/**
 * Request extension to include user and session data.
 */
declare global {
  namespace Express {
    interface Request {
      user?: Session;
      sessionId?: string;
    }
  }
}

/**
 * Creates a new session for a user.
 * @param user - User to create session for
 * @returns Session ID
 */
export async function createSession(user: Pick<User, 'id' | 'username' | 'role'>): Promise<string> {
  const sessionId = uuidv4();
  const now = Date.now();

  const session: Session = {
    userId: user.id,
    username: user.username,
    role: user.role,
    createdAt: now,
    lastActivity: now,
  };

  await redis.setex(
    `${SESSION_PREFIX}${sessionId}`,
    SESSION_TTL,
    JSON.stringify(session)
  );

  logger.info({ userId: user.id, username: user.username }, 'Session created');
  return sessionId;
}

/**
 * Retrieves and validates a session.
 * @param sessionId - Session ID to validate
 * @returns Session data or null if invalid/expired
 */
export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);
  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as Session;
  } catch {
    return null;
  }
}

/**
 * Extends a session's TTL on activity.
 * @param sessionId - Session ID to extend
 */
export async function extendSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (session) {
    session.lastActivity = Date.now();
    await redis.setex(
      `${SESSION_PREFIX}${sessionId}`,
      SESSION_TTL,
      JSON.stringify(session)
    );
  }
}

/**
 * Destroys a session (logout).
 * @param sessionId - Session ID to destroy
 */
export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(`${SESSION_PREFIX}${sessionId}`);
  logger.info({ sessionId }, 'Session destroyed');
}

/**
 * Simple password hashing (for demo purposes).
 * In production, use bcrypt or argon2.
 * @param password - Plain text password
 * @returns Hashed password
 */
function hashPassword(password: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Creates a new user.
 * @param username - Username
 * @param password - Plain text password
 * @param role - User role
 * @returns Created user (without password)
 */
export async function createUser(
  username: string,
  password: string,
  role: UserRole = 'user'
): Promise<Omit<User, 'passwordHash'>> {
  const id = uuidv4();
  const user: User = {
    id,
    username,
    passwordHash: hashPassword(password),
    role,
    createdAt: Date.now(),
  };

  await redis.set(`${USER_PREFIX}${username}`, JSON.stringify(user));
  logger.info({ userId: id, username, role }, 'User created');

  const { passwordHash: _, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

/**
 * Validates username and password.
 * @param username - Username
 * @param password - Plain text password
 * @returns User data or null if invalid
 */
export async function validateCredentials(
  username: string,
  password: string
): Promise<Omit<User, 'passwordHash'> | null> {
  const data = await redis.get(`${USER_PREFIX}${username}`);
  if (!data) {
    return null;
  }

  try {
    const user: User = JSON.parse(data);
    if (user.passwordHash === hashPassword(password)) {
      const { passwordHash: _, ...userWithoutPassword } = user;
      return userWithoutPassword;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Authentication middleware.
 * Validates session from cookie and adds user to request.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Skip auth in development if SKIP_AUTH is set
  if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true') {
    req.user = {
      userId: 'dev-user',
      username: 'developer',
      role: 'admin',
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    return next();
  }

  const sessionId = req.cookies?.session_id || req.headers['x-session-id'] as string;

  if (!sessionId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
    });
    return;
  }

  const session = await getSession(sessionId);

  if (!session) {
    res.status(401).json({
      success: false,
      error: 'Session expired or invalid',
    });
    return;
  }

  // Extend session on activity
  await extendSession(sessionId);

  req.user = session;
  req.sessionId = sessionId;
  next();
}

/**
 * Authorization middleware factory.
 * Creates middleware that checks if user has one of the allowed roles.
 * @param allowedRoles - Roles allowed to access the resource
 * @returns Express middleware
 */
export function authorize(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn(
        { userId: req.user.userId, role: req.user.role, required: allowedRoles },
        'Authorization denied'
      );
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to check if user owns the resource.
 * For job operations, checks if the user created the job.
 * Admins bypass this check.
 */
export function authorizeOwnerOrAdmin(
  getOwnerId: (req: Request) => Promise<string | null>
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    // Admins can access all resources
    if (req.user.role === 'admin') {
      return next();
    }

    const ownerId = await getOwnerId(req);
    if (ownerId && ownerId === req.user.userId) {
      return next();
    }

    logger.warn(
      { userId: req.user.userId, ownerId },
      'Authorization denied - not owner'
    );
    res.status(403).json({
      success: false,
      error: 'Access denied - not owner',
    });
  };
}

/**
 * Creates default admin user if it doesn't exist.
 * Called on server startup.
 */
export async function ensureAdminUser(): Promise<void> {
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  const existing = await redis.get(`${USER_PREFIX}${adminUsername}`);
  if (!existing) {
    await createUser(adminUsername, adminPassword, 'admin');
    logger.info({ username: adminUsername }, 'Default admin user created');
  }
}

/**
 * Rate limiting configuration per operation type.
 */
export const rateLimitConfig = {
  auth: { windowMs: 60000, max: 5 },      // 5 attempts per minute
  jobCreation: { windowMs: 60000, max: 10 }, // 10 jobs per minute
  jobTrigger: { windowMs: 60000, max: 30 },  // 30 triggers per minute
  read: { windowMs: 60000, max: 100 },     // 100 reads per minute
  admin: { windowMs: 60000, max: 50 },     // 50 admin ops per minute
};

logger.info('Auth module initialized');
