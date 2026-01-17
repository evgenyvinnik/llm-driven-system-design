/**
 * Authentication module for admin users.
 * Provides session-based auth using Redis for session storage.
 * Passwords are hashed with bcrypt for security.
 * @module shared/auth
 */

import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { pool } from './db.js'
import { redis } from './cache.js'

/** Session duration for regular logins (24 hours) */
const SESSION_TTL_DEFAULT = 24 * 60 * 60 // 24 hours in seconds

/** Extended session duration for "remember me" logins (30 days) */
const SESSION_TTL_REMEMBER = 30 * 24 * 60 * 60 // 30 days in seconds

/**
 * Represents a user session stored in Redis.
 */
interface Session {
  userId: string
  email: string
  name: string | null
  createdAt: number
}

/**
 * Represents an admin user from the database.
 */
interface AdminUser {
  id: string
  email: string
  password_hash: string
  name: string | null
}

/**
 * Generates a cryptographically secure session ID.
 * Uses 32 bytes of random data converted to hex (64 characters).
 *
 * @returns A random hex string suitable for use as a session ID
 */
function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Creates a new session for an authenticated admin user.
 * Stores session data in Redis with appropriate TTL.
 *
 * @param userId - The admin user's database ID
 * @param email - The admin user's email address
 * @param name - The admin user's display name (optional)
 * @param rememberMe - Whether to use extended session duration (30 days vs 24 hours)
 * @returns Object containing the session ID and TTL in seconds
 */
export async function createSession(
  userId: string,
  email: string,
  name: string | null,
  rememberMe = false
): Promise<{ sessionId: string; ttl: number }> {
  const sessionId = generateSessionId()
  const ttl = rememberMe ? SESSION_TTL_REMEMBER : SESSION_TTL_DEFAULT
  const session: Session = {
    userId,
    email,
    name,
    createdAt: Date.now(),
  }

  await redis.setex(`session:${sessionId}`, ttl, JSON.stringify(session))
  return { sessionId, ttl }
}

/**
 * Retrieves session data from Redis by session ID.
 * Returns null if the session doesn't exist or has expired.
 *
 * @param sessionId - The session ID from the client's cookie
 * @returns The session data or null if not found/expired
 */
export async function getSession(sessionId: string): Promise<Session | null> {
  const data = await redis.get(`session:${sessionId}`)
  if (!data) return null
  return JSON.parse(data) as Session
}

/**
 * Deletes a session from Redis, effectively logging out the user.
 *
 * @param sessionId - The session ID to invalidate
 * @returns Promise that resolves when session is deleted
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await redis.del(`session:${sessionId}`)
}

/**
 * Validates admin login credentials against the database.
 * Compares the provided password against the stored bcrypt hash.
 *
 * @param email - The email address to authenticate
 * @param password - The plaintext password to verify
 * @returns The admin user if credentials are valid, null otherwise
 */
export async function validateLogin(email: string, password: string): Promise<AdminUser | null> {
  const result = await pool.query(
    'SELECT id, email, password_hash, name FROM admin_users WHERE email = $1',
    [email]
  )

  if (result.rows.length === 0) {
    return null
  }

  const user = result.rows[0] as AdminUser
  const isValid = await bcrypt.compare(password, user.password_hash)

  if (!isValid) {
    return null
  }

  return user
}

/**
 * Hashes a password using bcrypt with a cost factor of 10.
 * Used when creating new admin users.
 *
 * @param password - The plaintext password to hash
 * @returns The bcrypt hash of the password
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

/**
 * Creates a new admin user in the database.
 * Hashes the password before storing.
 *
 * @param email - The email address for the new admin
 * @param password - The plaintext password (will be hashed)
 * @param name - Optional display name for the admin
 * @returns The new user's database ID
 */
export async function createAdminUser(email: string, password: string, name?: string): Promise<string> {
  const passwordHash = await hashPassword(password)
  const result = await pool.query(
    'INSERT INTO admin_users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
    [email, passwordHash, name || null]
  )
  return result.rows[0].id
}
