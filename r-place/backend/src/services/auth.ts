/**
 * Authentication service for user registration, login, and session management.
 *
 * Provides secure password hashing with bcrypt and session-based authentication
 * stored in PostgreSQL. Supports both registered users and anonymous guests.
 */
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from './database.js';
import { logger } from '../shared/logger.js';
import type { User, Session } from '../types/index.js';

/** Number of bcrypt hashing rounds for password security. */
const SALT_ROUNDS = 10;

/** Session validity duration in milliseconds (24 hours). */
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Service class handling all authentication operations.
 * Uses PostgreSQL for persistent storage of users and sessions.
 */
export class AuthService {
  /**
   * Registers a new user with a username and password.
   *
   * @param username - The desired username (must be unique).
   * @param password - The plaintext password to hash and store.
   * @returns Object containing success status and either the new user or an error message.
   */
  async register(
    username: string,
    password: string
  ): Promise<{ success: boolean; user?: User; error?: string }> {
    try {
      // Check if username already exists
      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM users WHERE username = $1',
        [username]
      );

      if (existing) {
        logger.info({ username }, 'Registration failed: username already exists');
        return { success: false, error: 'Username already exists' };
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      const userId = uuidv4();

      // Create user
      await query(
        `INSERT INTO users (id, username, password_hash, role)
         VALUES ($1, $2, $3, 'user')`,
        [userId, username, passwordHash]
      );

      logger.info({ userId, username }, 'User registered successfully');

      return {
        success: true,
        user: { id: userId, username, role: 'user' },
      };
    } catch (error) {
      logger.error({ error, username }, 'Registration error');
      return { success: false, error: 'Registration failed' };
    }
  }

  /**
   * Authenticates a user and creates a new session.
   *
   * @param username - The user's username.
   * @param password - The user's plaintext password to verify.
   * @returns Object containing success status, session, user data, or an error message.
   */
  async login(
    username: string,
    password: string
  ): Promise<{ success: boolean; session?: Session; user?: User; error?: string }> {
    try {
      const dbUser = await queryOne<{
        id: string;
        username: string;
        password_hash: string;
        role: 'user' | 'admin';
      }>('SELECT id, username, password_hash, role FROM users WHERE username = $1', [
        username,
      ]);

      if (!dbUser) {
        logger.info({ username }, 'Login failed: user not found');
        return { success: false, error: 'Invalid credentials' };
      }

      const passwordValid = await bcrypt.compare(password, dbUser.password_hash);
      if (!passwordValid) {
        logger.info({ username, userId: dbUser.id }, 'Login failed: invalid password');
        return { success: false, error: 'Invalid credentials' };
      }

      // Create session
      const sessionId = uuidv4();
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

      await query(
        `INSERT INTO sessions (id, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [sessionId, dbUser.id, expiresAt]
      );

      logger.info({ userId: dbUser.id, username }, 'User logged in successfully');

      return {
        success: true,
        session: { id: sessionId, userId: dbUser.id, expiresAt },
        user: { id: dbUser.id, username: dbUser.username, role: dbUser.role },
      };
    } catch (error) {
      logger.error({ error, username }, 'Login error');
      return { success: false, error: 'Login failed' };
    }
  }

  /**
   * Validates a session and returns the associated user.
   * Automatically deletes expired sessions.
   *
   * @param sessionId - The session UUID to validate.
   * @returns The authenticated user or null if the session is invalid/expired.
   */
  async validateSession(sessionId: string): Promise<User | null> {
    try {
      const result = await queryOne<{
        user_id: string;
        username: string;
        role: 'user' | 'admin';
        expires_at: Date;
      }>(
        `SELECT s.user_id, u.username, u.role, s.expires_at
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = $1`,
        [sessionId]
      );

      if (!result) {
        return null;
      }

      if (new Date() > result.expires_at) {
        // Session expired, delete it
        await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
        logger.debug({ sessionId }, 'Session expired and deleted');
        return null;
      }

      return {
        id: result.user_id,
        username: result.username,
        role: result.role,
      };
    } catch (error) {
      logger.error({ error, sessionId }, 'Session validation error');
      return null;
    }
  }

  /**
   * Logs out a user by deleting their session.
   *
   * @param sessionId - The session UUID to invalidate.
   */
  async logout(sessionId: string): Promise<void> {
    await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    logger.debug({ sessionId }, 'User logged out');
  }

  /**
   * Creates an anonymous guest user for quick access without registration.
   * Anonymous users get a random username and can place pixels like regular users.
   *
   * @returns Object containing the new anonymous user and their session.
   */
  async createAnonymousUser(): Promise<{ user: User; session: Session }> {
    const userId = uuidv4();
    const username = `anon_${userId.substring(0, 8)}`;
    const passwordHash = await bcrypt.hash(uuidv4(), SALT_ROUNDS);

    await query(
      `INSERT INTO users (id, username, password_hash, role)
       VALUES ($1, $2, $3, 'user')`,
      [userId, username, passwordHash]
    );

    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await query(
      `INSERT INTO sessions (id, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [sessionId, userId, expiresAt]
    );

    logger.info({ userId, username }, 'Anonymous user created');

    return {
      user: { id: userId, username, role: 'user' },
      session: { id: sessionId, userId, expiresAt },
    };
  }
}

/** Singleton instance of the authentication service. */
export const authService = new AuthService();
