import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, execute } from '../utils/db.js';
import { redis } from '../utils/redis.js';
import type { User, CreateUserInput, Session } from '../types/index.js';

const SALT_ROUNDS = 10;
const SESSION_EXPIRY_HOURS = 24;

export async function createUser(input: CreateUserInput): Promise<User> {
  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const result = await queryOne<User>(
    `INSERT INTO users (email, password_hash, name, phone, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, phone, role, created_at, updated_at`,
    [input.email, passwordHash, input.name, input.phone || null, input.role]
  );

  if (!result) {
    throw new Error('Failed to create user');
  }

  return result;
}

export async function getUserById(id: string): Promise<User | null> {
  return queryOne<User>(
    `SELECT id, email, name, phone, role, created_at, updated_at
     FROM users WHERE id = $1`,
    [id]
  );
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return queryOne<User & { password_hash: string }>(
    `SELECT id, email, password_hash, name, phone, role, created_at, updated_at
     FROM users WHERE email = $1`,
    [email]
  );
}

export async function validatePassword(
  email: string,
  password: string
): Promise<User | null> {
  const user = await getUserByEmail(email);
  if (!user || !user.password_hash) return null;

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) return null;

  // Remove password_hash from returned user
  const { password_hash: _, ...userWithoutPassword } = user;
  return userWithoutPassword as User;
}

export async function createSession(userId: string): Promise<Session> {
  const token = uuidv4();
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + SESSION_EXPIRY_HOURS);

  const session = await queryOne<Session>(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id, user_id, token, expires_at, created_at`,
    [userId, token, expiresAt]
  );

  if (!session) {
    throw new Error('Failed to create session');
  }

  // Store in Redis for fast lookup
  await redis.setex(
    `session:${token}`,
    SESSION_EXPIRY_HOURS * 3600,
    JSON.stringify({ userId, expiresAt: expiresAt.toISOString() })
  );

  return session;
}

export async function getSessionByToken(token: string): Promise<{ userId: string } | null> {
  // Try Redis first
  const cached = await redis.get(`session:${token}`);
  if (cached) {
    const session = JSON.parse(cached);
    if (new Date(session.expiresAt) > new Date()) {
      return { userId: session.userId };
    }
    // Session expired, remove from Redis
    await redis.del(`session:${token}`);
    return null;
  }

  // Fall back to database
  const session = await queryOne<Session>(
    `SELECT user_id, expires_at FROM sessions WHERE token = $1`,
    [token]
  );

  if (!session || new Date(session.expires_at) < new Date()) {
    return null;
  }

  // Cache in Redis
  const ttl = Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000);
  if (ttl > 0) {
    await redis.setex(
      `session:${token}`,
      ttl,
      JSON.stringify({ userId: session.user_id, expiresAt: session.expires_at })
    );
  }

  return { userId: session.user_id };
}

export async function deleteSession(token: string): Promise<void> {
  await execute(`DELETE FROM sessions WHERE token = $1`, [token]);
  await redis.del(`session:${token}`);
}

export async function deleteUserSessions(userId: string): Promise<void> {
  const sessions = await query<{ token: string }>(
    `SELECT token FROM sessions WHERE user_id = $1`,
    [userId]
  );

  await execute(`DELETE FROM sessions WHERE user_id = $1`, [userId]);

  // Remove from Redis
  if (sessions.length > 0) {
    const keys = sessions.map((s) => `session:${s.token}`);
    await redis.del(...keys);
  }
}

export async function updateUser(
  id: string,
  updates: Partial<Pick<User, 'name' | 'phone'>>
): Promise<User | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.phone !== undefined) {
    fields.push(`phone = $${paramIndex++}`);
    values.push(updates.phone);
  }

  if (fields.length === 0) {
    return getUserById(id);
  }

  values.push(id);

  return queryOne<User>(
    `UPDATE users SET ${fields.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING id, email, name, phone, role, created_at, updated_at`,
    values
  );
}

export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string
): Promise<boolean> {
  const user = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId]
  );

  if (!user) return false;

  const isValid = await bcrypt.compare(oldPassword, user.password_hash);
  if (!isValid) return false;

  const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await execute(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, userId]);

  return true;
}
