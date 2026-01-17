import pool from '../db/pool.js';
import bcrypt from 'bcrypt';
import { User } from '../types/index.js';

const SALT_ROUNDS = 10;

export class UserService {
  /**
   * Create a new user
   */
  async createUser(data: {
    email: string;
    password: string;
    name: string;
  }): Promise<User> {
    const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.email, passwordHash, data.name]
    );

    return result.rows[0];
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    const result = await pool.query(
      `SELECT * FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Verify password
   */
  async verifyPassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.password_hash);
  }

  /**
   * Update user profile
   */
  async updateUser(
    userId: string,
    data: { name?: string; email?: string }
  ): Promise<User | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    if (data.name) {
      fields.push(`name = $${paramCount++}`);
      values.push(data.name);
    }
    if (data.email) {
      fields.push(`email = $${paramCount++}`);
      values.push(data.email);
    }

    if (fields.length === 0) {
      return this.findById(userId);
    }

    fields.push(`updated_at = NOW()`);
    values.push(userId);

    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    return result.rows[0] || null;
  }

  /**
   * Change password
   */
  async changePassword(userId: string, newPassword: string): Promise<boolean> {
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    const result = await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, userId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get all users (for admin)
   */
  async getAllUsers(): Promise<User[]> {
    const result = await pool.query(
      `SELECT id, email, name, role, created_at, updated_at FROM users ORDER BY created_at DESC`
    );
    return result.rows;
  }

  /**
   * Get user statistics (for admin)
   */
  async getUserStats(): Promise<{ total: number; admins: number; thisWeek: number }> {
    const total = await pool.query(`SELECT COUNT(*) as count FROM users`);
    const admins = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE role = 'admin'`
    );
    const thisWeek = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE created_at > NOW() - INTERVAL '7 days'`
    );

    return {
      total: parseInt(total.rows[0].count),
      admins: parseInt(admins.rows[0].count),
      thisWeek: parseInt(thisWeek.rows[0].count),
    };
  }
}

export const userService = new UserService();
