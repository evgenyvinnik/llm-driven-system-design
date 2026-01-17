import { query } from '../config/database.js';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { setSession, getSession, deleteSession } from '../config/redis.js';
import type { User } from '../types/index.js';

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

export class AuthService {
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

  async logout(sessionId: string): Promise<void> {
    await deleteSession(sessionId);
  }

  async validateSession(sessionId: string): Promise<User | null> {
    const session = await getSession(sessionId);
    if (!session) return null;

    const result = await query(`SELECT * FROM users WHERE id = $1`, [session.userId]);
    if (result.rows.length === 0) return null;

    return mapUserRow(result.rows[0] as Record<string, unknown>);
  }

  async getUserById(userId: string): Promise<User | null> {
    const result = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (result.rows.length === 0) return null;
    return mapUserRow(result.rows[0] as Record<string, unknown>);
  }

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
