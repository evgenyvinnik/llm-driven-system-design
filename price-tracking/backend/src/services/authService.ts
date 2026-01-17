import bcrypt from 'bcrypt';
import { query, queryOne } from '../db/pool.js';
import { setSession, getSession, deleteSession } from '../db/redis.js';
import { User, Session } from '../types/index.js';
import { generateToken } from '../utils/helpers.js';
import logger from '../utils/logger.js';

/** Number of bcrypt salt rounds for password hashing */
const SALT_ROUNDS = 10;

/**
 * Registers a new user account with email and password.
 * Hashes the password with bcrypt and creates an initial session.
 * @param email - User's email address
 * @param password - Plain text password (will be hashed)
 * @returns Object containing the user (without password_hash) and session token
 * @throws Error if email is already registered
 */
export async function register(email: string, password: string): Promise<{ user: Omit<User, 'password_hash'>; token: string }> {
  // Check if user exists
  const existing = await queryOne<User>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    throw new Error('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Create user
  const user = await queryOne<User>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, role, email_notifications, created_at, updated_at`,
    [email, passwordHash]
  );

  if (!user) {
    throw new Error('Failed to create user');
  }

  // Create session
  const token = generateToken(64);
  await createSession(user.id, token);

  logger.info(`User registered: ${user.id}`);

  return { user, token };
}

/**
 * Authenticates a user with email and password credentials.
 * Verifies password against stored bcrypt hash and creates a new session.
 * @param email - User's email address
 * @param password - Plain text password to verify
 * @returns Object containing the user (without password_hash) and session token
 * @throws Error if credentials are invalid
 */
export async function login(email: string, password: string): Promise<{ user: Omit<User, 'password_hash'>; token: string }> {
  // Get user
  const user = await queryOne<User>(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (!user) {
    throw new Error('Invalid email or password');
  }

  // Verify password
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new Error('Invalid email or password');
  }

  // Create session
  const token = generateToken(64);
  await createSession(user.id, token);

  logger.info(`User logged in: ${user.id}`);

  // Remove password hash from response
  const { password_hash: _, ...userWithoutPassword } = user;
  return { user: userWithoutPassword, token };
}

/**
 * Logs out a user by invalidating their session token.
 * Removes the session from both Redis and the database.
 * @param token - The session token to invalidate
 */
export async function logout(token: string): Promise<void> {
  await deleteSession(token);
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

/**
 * Validates a session token and returns the associated user.
 * First checks Redis cache, then falls back to database lookup.
 * Refreshes the Redis cache on successful database validation.
 * @param token - The session token to validate
 * @returns The user if session is valid, null otherwise
 */
export async function validateSession(token: string): Promise<User | null> {
  // Check Redis cache first
  const cachedUserId = await getSession(token);
  if (cachedUserId) {
    return getUserById(cachedUserId);
  }

  // Check database
  const session = await queryOne<Session>(
    'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()',
    [token]
  );

  if (!session) {
    return null;
  }

  // Refresh Redis cache
  await setSession(token, session.user_id);

  return getUserById(session.user_id);
}

/**
 * Retrieves a user by their unique ID.
 * Excludes password_hash from the result for security.
 * @param userId - The UUID of the user
 * @returns The user or null if not found
 */
export async function getUserById(userId: string): Promise<User | null> {
  return queryOne<User>(
    'SELECT id, email, role, email_notifications, created_at, updated_at FROM users WHERE id = $1',
    [userId]
  );
}

/**
 * Updates a user's settings such as email notification preferences.
 * @param userId - The user ID to update
 * @param updates - Object containing optional email_notifications preference
 * @returns The updated user or null if not found
 */
export async function updateUser(
  userId: string,
  updates: { email_notifications?: boolean }
): Promise<User | null> {
  const result = await query<User>(
    `UPDATE users
     SET email_notifications = COALESCE($2, email_notifications),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, email, role, email_notifications, created_at, updated_at`,
    [userId, updates.email_notifications]
  );
  return result[0] || null;
}

/**
 * Creates a new session for a user in both database and Redis.
 * Sessions expire after 7 days.
 * @param userId - The user ID to create a session for
 * @param token - The generated session token
 */
async function createSession(userId: string, token: string): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await query(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  await setSession(token, userId);
}

/**
 * Removes expired sessions from the database.
 * Should be called periodically (e.g., via cron) to clean up old sessions.
 * Redis sessions auto-expire via TTL.
 * @returns The number of sessions deleted
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await query<{ id: string }>(
    'DELETE FROM sessions WHERE expires_at < NOW() RETURNING id',
    []
  );
  return result.length;
}
