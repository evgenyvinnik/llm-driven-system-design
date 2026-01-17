import { pool, redis } from '../db/index.js';
import {
  type User,
  type CreateUserInput,
} from '../types/index.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

const SALT_ROUNDS = 10;

export class UserService {
  /**
   * Create a new user
   */
  async createUser(input: CreateUserInput): Promise<User> {
    const { email, password, name, time_zone } = input;

    // Check if user already exists
    const existing = await this.findByEmail(email);
    if (existing) {
      throw new Error('User with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const id = uuidv4();

    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash, name, time_zone, role)
       VALUES ($1, $2, $3, $4, $5, 'user')
       RETURNING id, email, name, time_zone, role, created_at, updated_at`,
      [id, email, passwordHash, name, time_zone]
    );

    return result.rows[0];
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    const cacheKey = `user:${id}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const result = await pool.query(
      `SELECT id, email, name, time_zone, role, created_at, updated_at
       FROM users WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];
    await redis.setex(cacheKey, 3600, JSON.stringify(user));

    return user;
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<User | null> {
    const result = await pool.query(
      `SELECT id, email, name, time_zone, role, created_at, updated_at
       FROM users WHERE email = $1`,
      [email]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Validate user credentials
   */
  async validateCredentials(email: string, password: string): Promise<User | null> {
    const result = await pool.query(
      `SELECT id, email, password_hash, name, time_zone, role, created_at, updated_at
       FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return null;
    }

    // Remove password_hash before returning
    const { password_hash, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Update user profile
   */
  async updateUser(
    id: string,
    updates: { name?: string; time_zone?: string }
  ): Promise<User | null> {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    let paramIndex = 1;

    if (updates.name) {
      fields.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }

    if (updates.time_zone) {
      fields.push(`time_zone = $${paramIndex++}`);
      values.push(updates.time_zone);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, email, name, time_zone, role, created_at, updated_at`,
      values
    );

    if (result.rows.length === 0) {
      return null;
    }

    // Invalidate cache
    await redis.del(`user:${id}`);

    return result.rows[0];
  }

  /**
   * Get all users (admin only)
   */
  async getAllUsers(): Promise<User[]> {
    const result = await pool.query(
      `SELECT id, email, name, time_zone, role, created_at, updated_at
       FROM users ORDER BY created_at DESC`
    );

    return result.rows;
  }

  /**
   * Delete user
   */
  async deleteUser(id: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM users WHERE id = $1`,
      [id]
    );

    if (result.rowCount && result.rowCount > 0) {
      await redis.del(`user:${id}`);
      return true;
    }

    return false;
  }
}

export const userService = new UserService();
