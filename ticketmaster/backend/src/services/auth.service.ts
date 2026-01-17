import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import redis from '../db/redis.js';
import type { User, Session } from '../types/index.js';

const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds
const SALT_ROUNDS = 10;

export class AuthService {
  async register(email: string, password: string, name: string): Promise<User> {
    // Check if user exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new Error('User already exists');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'user')
       RETURNING id, email, name, role, created_at, updated_at`,
      [email, passwordHash, name]
    );

    return result.rows[0];
  }

  async login(email: string, password: string): Promise<{ user: User; session: Session }> {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      throw new Error('Invalid credentials');
    }

    const user = result.rows[0] as User;
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      throw new Error('Invalid credentials');
    }

    // Create session
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

    await query(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)',
      [sessionId, user.id, expiresAt]
    );

    // Store session in Redis for fast lookup
    await redis.setex(
      `session:${sessionId}`,
      SESSION_TTL,
      JSON.stringify({ userId: user.id, role: user.role })
    );

    const session: Session = {
      id: sessionId,
      user_id: user.id,
      created_at: new Date(),
      expires_at: expiresAt,
    };

    return { user, session };
  }

  async logout(sessionId: string): Promise<void> {
    await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await redis.del(`session:${sessionId}`);
  }

  async validateSession(sessionId: string): Promise<{ userId: string; role: string } | null> {
    // Try Redis first
    const cached = await redis.get(`session:${sessionId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Fall back to database
    const result = await query(
      `SELECT s.user_id, u.role FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND s.expires_at > NOW()`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const { user_id, role } = result.rows[0];

    // Cache in Redis
    await redis.setex(
      `session:${sessionId}`,
      SESSION_TTL,
      JSON.stringify({ userId: user_id, role })
    );

    return { userId: user_id, role };
  }

  async getUserById(userId: string): Promise<User | null> {
    const result = await query(
      'SELECT id, email, name, role, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }
}

export const authService = new AuthService();
