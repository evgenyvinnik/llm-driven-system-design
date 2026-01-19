import { pool } from '../db.js';
import bcrypt from 'bcrypt';
import type { User, UserRegistration, UserLogin, UserProfileUpdate } from '../types.js';

const SALT_ROUNDS = 10;

// Register a new user
export async function register({
  email,
  password,
  username,
  displayName,
}: UserRegistration): Promise<User> {
  // Check if user already exists
  const existingUser = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (existingUser.rows.length > 0) {
    throw new Error('User with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await pool.query(
    `INSERT INTO users (email, password_hash, username, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, username, display_name, avatar_url, is_premium, role, created_at`,
    [email, passwordHash, username, displayName || username]
  );

  return result.rows[0] as User;
}

// Login user
export async function login({ email, password }: UserLogin): Promise<User> {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid email or password');
  }

  const user = result.rows[0] as User;
  const isValidPassword = await bcrypt.compare(password, user.password_hash || '');

  if (!isValidPassword) {
    throw new Error('Invalid email or password');
  }

  // Return user without password
  const { password_hash, ...safeUser } = user;
  return safeUser as User;
}

// Get user by ID
export async function getUserById(userId: string): Promise<User | null> {
  const result = await pool.query(
    `SELECT id, email, username, display_name, avatar_url, is_premium, role, created_at
     FROM users WHERE id = $1`,
    [userId]
  );

  return (result.rows[0] as User) || null;
}

// Update user profile
export async function updateProfile(
  userId: string,
  updates: UserProfileUpdate
): Promise<User> {
  const allowedFields = ['display_name', 'avatar_url'];
  const updateEntries = Object.entries(updates).filter(([key]) =>
    allowedFields.includes(key)
  );

  if (updateEntries.length === 0) {
    const user = await getUserById(userId);
    if (!user) throw new Error('User not found');
    return user;
  }

  const setClause = updateEntries
    .map(([key], index) => `${key} = $${index + 2}`)
    .join(', ');
  const values = updateEntries.map(([, value]) => value);

  const result = await pool.query(
    `UPDATE users SET ${setClause}, updated_at = NOW()
     WHERE id = $1
     RETURNING id, email, username, display_name, avatar_url, is_premium, role, created_at`,
    [userId, ...values]
  );

  return result.rows[0] as User;
}

export default {
  register,
  login,
  getUserById,
  updateProfile,
};
