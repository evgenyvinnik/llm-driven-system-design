import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from './database.js';
import type { User, Session } from '../types/index.js';

const SALT_ROUNDS = 10;
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AuthService {
  // Register a new user
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

      return {
        success: true,
        user: { id: userId, username, role: 'user' },
      };
    } catch (error) {
      console.error('Registration error:', error);
      return { success: false, error: 'Registration failed' };
    }
  }

  // Login user
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
        return { success: false, error: 'Invalid credentials' };
      }

      const passwordValid = await bcrypt.compare(password, dbUser.password_hash);
      if (!passwordValid) {
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

      return {
        success: true,
        session: { id: sessionId, userId: dbUser.id, expiresAt },
        user: { id: dbUser.id, username: dbUser.username, role: dbUser.role },
      };
    } catch (error) {
      console.error('Login error:', error);
      return { success: false, error: 'Login failed' };
    }
  }

  // Validate session
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
        return null;
      }

      return {
        id: result.user_id,
        username: result.username,
        role: result.role,
      };
    } catch (error) {
      console.error('Session validation error:', error);
      return null;
    }
  }

  // Logout (delete session)
  async logout(sessionId: string): Promise<void> {
    await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }

  // Create anonymous user (for quick access without registration)
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

    return {
      user: { id: userId, username, role: 'user' },
      session: { id: sessionId, userId, expiresAt },
    };
  }
}

export const authService = new AuthService();
