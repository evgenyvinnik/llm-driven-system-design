import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../utils/db.js';
import { redis } from '../utils/redis.js';
import type { User, CreateUserInput, Session } from '../types/index.js';

/** Number of bcrypt salt rounds for password hashing. Higher = more secure but slower. */
const SALT_ROUNDS = 10;

/** Session validity period in hours before requiring re-authentication. */
const SESSION_EXPIRY_HOURS = 24;

/**
 * Creates a new user account with hashed password.
 * Core registration function for customers, drivers, and merchants.
 *
 * @param input - User registration data including email, password, and role
 * @returns The newly created user (without password hash)
 * @throws Error if user creation fails (e.g., duplicate email)
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const result = await queryOne<User>(
    `INSERT INTO users (email, password_hash, name, phone, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, phone, role, created_at, updated_at`,
    [input.email, passwordHash, input.name, input.phone || null, input.role]
  );

  if (!result) {
    throw new Error('Failed to create user');
  }

  return result;
}

/**
 * Retrieves a user by their unique identifier.
 * Returns user data without the password hash for security.
 *
 * @param id - The user's UUID
 * @returns User object or null if not found
 */
export async function getUserById(id: string): Promise<User | null> {
  return queryOne<User>(
    `SELECT id, email, name, phone, role, created_at, updated_at
     FROM users WHERE id = $1`,
    [id]
  );
}

/**
 * Retrieves a user by their email address.
 * Includes password hash for authentication purposes.
 *
 * @param email - The user's email address
 * @returns User object with password hash, or null if not found
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  return queryOne<User & { password_hash: string }>(
    `SELECT id, email, password_hash, name, phone, role, created_at, updated_at
     FROM users WHERE email = $1`,
    [email]
  );
}

/**
 * Validates user credentials for login.
 * Compares provided password against stored bcrypt hash.
 *
 * @param email - User's email address
 * @param password - Plain text password to verify
 * @returns User object (without password) if valid, null otherwise
 */
export async function validatePassword(
  email: string,
  password: string
): Promise<User | null> {
  const user = await getUserByEmail(email);
  if (!user || !user.password_hash) return null;

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) return null;

  // Remove password_hash from returned user
  const { password_hash: _, ...userWithoutPassword } = user;
  return userWithoutPassword as User;
}

/**
 * Creates a new authenticated session for a user.
 * Stores session in both PostgreSQL (durability) and Redis (fast lookups).
 * Uses UUID tokens for security instead of predictable identifiers.
 *
 * @param userId - The user's unique identifier
 * @returns Session object containing token and expiry
 * @throws Error if session creation fails
 */
export async function createSession(userId: string): Promise<Session> {
  const token = uuidv4();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + SESSION_EXPIRY_HOURS);

  const session = await queryOne<Session>(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, token, expires_at, created_at`,
    [userId, token, expiresAt]
  );

  if (!session) {
    throw new Error('Failed to create session');
  }

  // Store in Redis for fast lookup
  await redis.setex(
    `session:${token}`,
    SESSION_EXPIRY_HOURS * 3600,
    JSON.stringify({ userId, expiresAt: expiresAt.toISOString() })
  );

  return session;
}

/**
 * Validates a session token and returns the associated user ID.
 * Checks Redis cache first for performance, falls back to database.
 * Automatically removes expired sessions.
 *
 * @param token - The session token to validate
 * @returns Object with userId if valid, null if expired or invalid
 */
export async function getSessionByToken(token: string): Promise<{ userId: string } | null> {
  // Try Redis first
  const cached = await redis.get(`session:${token}`);
  if (cached) {
    const session = JSON.parse(cached);
    if (new Date(session.expiresAt) > new Date()) {
      return { userId: session.userId };
    }
    // Session expired, remove from Redis
    await redis.del(`session:${token}`);
    return null;
  }

  // Fall back to database
  const session = await queryOne<Session>(
    `SELECT user_id, expires_at FROM sessions WHERE token = $1`,
    [token]
  );

  if (!session || new Date(session.expires_at) < new Date()) {
    return null;
  }

  // Cache in Redis
  const ttl = Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000);
  if (ttl > 0) {
    await redis.setex(
      `session:${token}`,
      ttl,
      JSON.stringify({ userId: session.user_id, expiresAt: session.expires_at })
    );
  }

  return { userId: session.user_id };
}

/**
 * Invalidates a session token (logout).
 * Removes from both database and Redis cache.
 *
 * @param token - The session token to invalidate
 */
export async function deleteSession(token: string): Promise<void> {
  await execute(`DELETE FROM sessions WHERE token = $1`, [token]);
  await redis.del(`session:${token}`);
}

/**
 * Invalidates all sessions for a user (force logout everywhere).
 * Useful for password changes or security concerns.
 *
 * @param userId - The user whose sessions should be invalidated
 */
export async function deleteUserSessions(userId: string): Promise<void> {
  const sessions = await query<{ token: string }>(
    `SELECT token FROM sessions WHERE user_id = $1`,
    [userId]
  );

  await execute(`DELETE FROM sessions WHERE user_id = $1`, [userId]);

  // Remove from Redis
  if (sessions.length > 0) {
    const keys = sessions.map((s) => `session:${s.token}`);
    await redis.del(...keys);
  }
}

/**
 * Updates a user's profile information.
 * Only allows updating name and phone (not email or role).
 *
 * @param id - The user's unique identifier
 * @param updates - Partial user data to update
 * @returns Updated user object or null if not found
 */
export async function updateUser(
  id: string,
  updates: Partial<Pick<User, 'name' | 'phone'>>
): Promise<User | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.phone !== undefined) {
    fields.push(`phone = $${paramIndex++}`);
    values.push(updates.phone);
  }

  if (fields.length === 0) {
    return getUserById(id);
  }

  values.push(id);

  return queryOne<User>(
    `UPDATE users SET ${fields.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING id, email, name, phone, role, created_at, updated_at`,
    values
  );
}

/**
 * Changes a user's password after verifying the old password.
 * Requires knowledge of current password for security.
 *
 * @param userId - The user's unique identifier
 * @param oldPassword - Current password for verification
 * @param newPassword - New password to set
 * @returns True if password changed successfully, false if old password invalid
 */
export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string
): Promise<boolean> {
  const user = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId]
  );

  if (!user) return false;

  const isValid = await bcrypt.compare(oldPassword, user.password_hash);
  if (!isValid) return false;

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await execute(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, userId]);

  return true;
}
