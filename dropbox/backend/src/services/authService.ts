import bcrypt from 'bcrypt';
import { query, queryOne } from '../utils/database.js';
import { setSession, deleteSession } from '../utils/redis.js';
import { User, AuthResponse } from '../types/index.js';
import { generateToken } from '../utils/chunking.js';

const SESSION_EXPIRY_HOURS = parseInt(process.env.SESSION_EXPIRY_HOURS || '24', 10);

export async function register(
  email: string,
  password: string,
  name: string
): Promise<AuthResponse> {
  // Check if user exists
  const existing = await queryOne<User>(
    `SELECT id FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );

  if (existing) {
    throw new Error('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Create user
  const result = await query<User>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes"`,
    [email.toLowerCase(), passwordHash, name]
  );

  const user = result[0];

  // Create session
  const token = generateToken(64);
  const expirySeconds = SESSION_EXPIRY_HOURS * 60 * 60;
  await setSession(token, user.id, expirySeconds);

  // Store in database too for persistence
  const expiresAt = new Date(Date.now() + expirySeconds * 1000);
  await query(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, token, expiresAt]
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
    },
    token,
  };
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  // Find user
  const user = await queryOne<User & { password_hash: string }>(
    `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes", password_hash
     FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );

  if (!user) {
    throw new Error('Invalid email or password');
  }

  // Verify password
  const passwordMatch = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatch) {
    throw new Error('Invalid email or password');
  }

  // Create session
  const token = generateToken(64);
  const expirySeconds = SESSION_EXPIRY_HOURS * 60 * 60;
  await setSession(token, user.id, expirySeconds);

  // Store in database
  const expiresAt = new Date(Date.now() + expirySeconds * 1000);
  await query(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, token, expiresAt]
  );

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
    },
    token,
  };
}

export async function logout(token: string): Promise<void> {
  await deleteSession(token);
  await query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

export async function getUserById(userId: string): Promise<User | null> {
  return queryOne<User>(
    `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes",
            created_at as "createdAt", updated_at as "updatedAt"
     FROM users WHERE id = $1`,
    [userId]
  );
}

export async function updateUser(
  userId: string,
  updates: { name?: string; password?: string }
): Promise<User> {
  let passwordHash: string | undefined;

  if (updates.password) {
    passwordHash = await bcrypt.hash(updates.password, 10);
  }

  const result = await query<User>(
    `UPDATE users
     SET name = COALESCE($1, name),
         password_hash = COALESCE($2, password_hash),
         updated_at = NOW()
     WHERE id = $3
     RETURNING id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes"`,
    [updates.name, passwordHash, userId]
  );

  if (result.length === 0) {
    throw new Error('User not found');
  }

  return result[0];
}

// Admin functions
export async function getAllUsers(): Promise<User[]> {
  return query<User>(
    `SELECT id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes",
            created_at as "createdAt", updated_at as "updatedAt"
     FROM users ORDER BY created_at DESC`
  );
}

export async function updateUserQuota(userId: string, quotaBytes: number): Promise<User> {
  const result = await query<User>(
    `UPDATE users SET quota_bytes = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, email, name, role, quota_bytes as "quotaBytes", used_bytes as "usedBytes"`,
    [quotaBytes, userId]
  );

  if (result.length === 0) {
    throw new Error('User not found');
  }

  return result[0];
}

export async function deleteUser(userId: string): Promise<void> {
  // Cascade delete will handle files, sessions, etc.
  await query(`DELETE FROM users WHERE id = $1`, [userId]);
}
