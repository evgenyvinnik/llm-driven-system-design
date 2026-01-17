/**
 * @fileoverview Authentication service for user management.
 * Handles registration, login, session validation, and role management.
 */

import { query } from '../config/database.js';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { setSession, getSession, deleteSession } from '../config/redis.js';
import type { User } from '../types/index.js';

/**
 * Maps a database row to a User object.
 * Converts snake_case columns to camelCase properties.
 * @param row - Raw database row
 * @returns Typed User object
 */
function mapUserRow(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    username: row.username as string,
    displayName: row.display_name as string | null,
    role: row.role as User['role'],
    avatarUrl: row.avatar_url as string | null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Service class for authentication and user management operations.
 * Uses Redis for session storage and bcrypt for password hashing.
 */
export class AuthService {
  /**
   * Registers a new user account with hashed password.
   * Creates a session and returns both user data and session ID.
   * @param data - Registration data including email, password, username
   * @returns User object and session ID for immediate login
   * @throws Error if email or username already exists
   */
  async register(data: {
    email: string;
    password: string;
    username: string;
    displayName?: string;
  }): Promise<{ user: User; sessionId: string }> {
    // Check if email or username exists
    const existing = await query(`
      SELECT id FROM users WHERE email = $1 OR username = $2
    `, [data.email, data.username]);

    if (existing.rows.length > 0) {
      throw new Error('Email or username already exists');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    const result = await query(`
      INSERT INTO users (email, password_hash, username, display_name)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [data.email, passwordHash, data.username, data.displayName || null]);

    const user = mapUserRow(result.rows[0] as Record<string, unknown>);
    const sessionId = uuid();
    await setSession(sessionId, user.id, { role: user.role });

    return { user, sessionId };
  }

  /**
   * Authenticates a user with email and password.
   * @param email - User's email address
   * @param password - Plain text password to verify
   * @returns User object and new session ID
   * @throws Error if credentials are invalid
   */
  async login(email: string, password: string): Promise<{ user: User; sessionId: string }> {
    const result = await query(`
      SELECT * FROM users WHERE email = $1
    `, [email]);

    if (result.rows.length === 0) {
      throw new Error('Invalid credentials');
    }

    const row = result.rows[0];
    const isValid = await bcrypt.compare(password, row.password_hash as string);

    if (!isValid) {
      throw new Error('Invalid credentials');
    }

    const user = mapUserRow(row as Record<string, unknown>);
    const sessionId = uuid();
    await setSession(sessionId, user.id, { role: user.role });

    return { user, sessionId };
  }

  /**
   * Invalidates a user session, logging them out.
   * @param sessionId - Session ID to invalidate
   */
  async logout(sessionId: string): Promise<void> {
    await deleteSession(sessionId);
  }

  /**
   * Validates a session and retrieves the associated user.
   * @param sessionId - Session ID to validate
   * @returns User object if session is valid, null otherwise
   */
  async validateSession(sessionId: string): Promise<User | null> {
    const session = await getSession(sessionId);
    if (!session) return null;

    const result = await query(`SELECT * FROM users WHERE id = $1`, [session.userId]);
    if (result.rows.length === 0) return null;

    return mapUserRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Retrieves a user by their ID.
   * @param userId - User's UUID
   * @returns User object or null if not found
   */
  async getUserById(userId: string): Promise<User | null> {
    const result = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (result.rows.length === 0) return null;
    return mapUserRow(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Updates user profile information.
   * @param userId - User's UUID
   * @param data - Fields to update (displayName, avatarUrl)
   * @returns Updated user object or null if user not found
   */
  async updateUser(userId: string, data: Partial<{
    displayName: string;
    avatarUrl: string;
  }>): Promise<User | null> {
    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (data.displayName !== undefined) {
      updates.push(`display_name = $${paramIndex}`);
      params.push(data.displayName);
      paramIndex++;
    }

    if (data.avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramIndex}`);
      params.push(data.avatarUrl);
      paramIndex++;
    }

    if (updates.length === 0) {
      return this.getUserById(userId);
    }

    updates.push('updated_at = NOW()');
    params.push(userId);

    await query(`
      UPDATE users SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
    `, params);

    return this.getUserById(userId);
  }

  /**
   * Changes a user's password after verifying current password.
   * @param userId - User's UUID
   * @param currentPassword - Current password for verification
   * @param newPassword - New password to set
   * @returns True if password was changed successfully
   * @throws Error if current password is incorrect
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
    const result = await query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
    if (result.rows.length === 0) return false;

    const isValid = await bcrypt.compare(currentPassword, result.rows[0].password_hash as string);
    if (!isValid) {
      throw new Error('Current password is incorrect');
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [newHash, userId]);

    return true;
  }

  async becomeDeveloper(userId: string, data: {
    name: string;
    email: string;
    website?: string;
    description?: string;
  }): Promise<void> {
    // Check if already a developer
    const existing = await query(`SELECT id FROM developers WHERE user_id = $1`, [userId]);
    if (existing.rows.length > 0) {
      throw new Error('Already a developer');
    }

    // Create developer account
    await query(`
      INSERT INTO developers (user_id, name, email, website, description)
      VALUES ($1, $2, $3, $4, $5)
    `, [userId, data.name, data.email, data.website || null, data.description || null]);

    // Update user role
    await query(`UPDATE users SET role = 'developer', updated_at = NOW() WHERE id = $1`, [userId]);
  }
}

export const authService = new AuthService();
