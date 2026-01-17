import bcrypt from 'bcryptjs';
import { query } from '../config/database.js';
import { User } from '../types/index.js';

// Get user by ID
export async function getUserById(userId: string): Promise<User | null> {
  const { rows } = await query<User>(
    'SELECT id, email, name, avatar_url, role, created_at, updated_at FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

// Get user by email
export async function getUserByEmail(email: string): Promise<User | null> {
  const { rows } = await query<User>(
    'SELECT id, email, name, avatar_url, role, created_at, updated_at FROM users WHERE email = $1',
    [email]
  );
  return rows[0] || null;
}

// Get all users
export async function getAllUsers(): Promise<User[]> {
  const { rows } = await query<User>(
    'SELECT id, email, name, avatar_url, role, created_at, updated_at FROM users ORDER BY name'
  );
  return rows;
}

// Create user
export async function createUser(data: {
  email: string;
  password: string;
  name: string;
  role?: 'user' | 'admin';
}): Promise<User> {
  const passwordHash = await bcrypt.hash(data.password, 10);

  const { rows } = await query<User>(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, avatar_url, role, created_at, updated_at`,
    [data.email, passwordHash, data.name, data.role || 'user']
  );

  return rows[0];
}

// Update user
export async function updateUser(
  userId: string,
  data: Partial<Pick<User, 'name' | 'avatar_url'>>
): Promise<User | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.avatar_url !== undefined) {
    fields.push(`avatar_url = $${paramIndex++}`);
    values.push(data.avatar_url);
  }

  if (fields.length === 0) return null;

  fields.push('updated_at = NOW()');
  values.push(userId);

  const { rows } = await query<User>(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}
     RETURNING id, email, name, avatar_url, role, created_at, updated_at`,
    values
  );

  return rows[0] || null;
}

// Change password
export async function changePassword(userId: string, newPassword: string): Promise<boolean> {
  const passwordHash = await bcrypt.hash(newPassword, 10);

  const { rowCount } = await query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [passwordHash, userId]
  );

  return (rowCount ?? 0) > 0;
}

// Verify password
export async function verifyPassword(email: string, password: string): Promise<User | null> {
  const { rows } = await query<User & { password_hash: string }>(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (rows.length === 0) return null;

  const user = rows[0];
  const isValid = await bcrypt.compare(password, user.password_hash);

  if (!isValid) return null;

  // Return user without password hash
  const { password_hash, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

// Search users
export async function searchUsers(searchTerm: string, limit: number = 10): Promise<User[]> {
  const { rows } = await query<User>(
    `SELECT id, email, name, avatar_url, role, created_at, updated_at
     FROM users
     WHERE name ILIKE $1 OR email ILIKE $1
     ORDER BY name
     LIMIT $2`,
    [`%${searchTerm}%`, limit]
  );

  return rows;
}
