import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../models/db.js';
import redis from '../models/redis.js';

const SESSION_TTL = 24 * 60 * 60; // 24 hours in seconds

export interface RegisterUserData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role?: 'user' | 'hotel_admin' | 'admin';
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: string;
  createdAt?: Date;
}

export interface AuthResult {
  user: User;
  token: string;
}

export interface Session {
  token: string;
  expiresAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: string;
  created_at: Date;
}

interface SessionCache {
  userId: string;
}

class AuthService {
  async register(userData: RegisterUserData): Promise<AuthResult> {
    const { email, password, firstName, lastName, phone, role = 'user' } = userData;

    // Check if user exists
    const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new Error('Email already registered');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const result = await query<UserRow>(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, phone, role, created_at`,
      [email, passwordHash, firstName, lastName, phone || null, role]
    );

    const user = result.rows[0];
    if (!user) {
      throw new Error('Failed to create user');
    }

    // Create session
    const session = await this.createSession(user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
      },
      token: session.token,
    };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const result = await query<UserRow>(
      'SELECT id, email, password_hash, first_name, last_name, phone, role FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid credentials');
    }

    const user = result.rows[0];
    if (!user) {
      throw new Error('Invalid credentials');
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      throw new Error('Invalid credentials');
    }

    // Create session
    const session = await this.createSession(user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phone: user.phone,
        role: user.role,
      },
      token: session.token,
    };
  }

  async createSession(userId: string): Promise<Session> {
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

    // Store in PostgreSQL
    await query(
      'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, token, expiresAt]
    );

    // Store in Redis for fast lookup
    await redis.setex(`session:${token}`, SESSION_TTL, JSON.stringify({ userId }));

    return { token, expiresAt };
  }

  async validateSession(token: string): Promise<User | null> {
    // Check Redis first
    const cached = await redis.get(`session:${token}`);
    if (cached) {
      const { userId } = JSON.parse(cached) as SessionCache;
      const userResult = await query<UserRow>(
        'SELECT id, email, first_name, last_name, phone, role FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        if (user) {
          return {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phone: user.phone,
            role: user.role,
          };
        }
      }
    }

    // Fall back to database
    const result = await query<UserRow>(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.role
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];
    if (!user) {
      return null;
    }

    // Refresh Redis cache
    await redis.setex(`session:${token}`, SESSION_TTL, JSON.stringify({ userId: user.id }));

    return {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      phone: user.phone,
      role: user.role,
    };
  }

  async logout(token: string): Promise<void> {
    await query('DELETE FROM sessions WHERE token = $1', [token]);
    await redis.del(`session:${token}`);
  }

  async getUserById(userId: string): Promise<User | null> {
    const result = await query<UserRow>(
      'SELECT id, email, first_name, last_name, phone, role, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];
    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      phone: user.phone,
      role: user.role,
      createdAt: user.created_at,
    };
  }
}

export default new AuthService();
