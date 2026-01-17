import bcrypt from 'bcrypt';
import { query, queryOne } from '../db/pool.js';
import { setSession, getSession, deleteSession } from '../db/redis.js';
import { User, Session } from '../types/index.js';
import { generateToken } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const SALT_ROUNDS = 10;

export async function register(email: string, password: string): Promise<{ user: Omit<User, 'password_hash'>; token: string }> {
  // Check if user exists
  const existing = await queryOne<User>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    throw new Error('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // Create user
  const user = await queryOne<User>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, role, email_notifications, created_at, updated_at`,
    [email, passwordHash]
  );

  if (!user) {
    throw new Error('Failed to create user');
  }

  // Create session
  const token = generateToken(64);
  await createSession(user.id, token);

  logger.info(`User registered: ${user.id}`);

  return { user, token };
}

export async function login(email: string, password: string): Promise<{ user: Omit<User, 'password_hash'>; token: string }> {
  // Get user
  const user = await queryOne<User>(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (!user) {
    throw new Error('Invalid email or password');
  }

  // Verify password
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new Error('Invalid email or password');
  }

  // Create session
  const token = generateToken(64);
  await createSession(user.id, token);

  logger.info(`User logged in: ${user.id}`);

  // Remove password hash from response
  const { password_hash: _, ...userWithoutPassword } = user;
  return { user: userWithoutPassword, token };
}

export async function logout(token: string): Promise<void> {
  await deleteSession(token);
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

export async function validateSession(token: string): Promise<User | null> {
  // Check Redis cache first
  const cachedUserId = await getSession(token);
  if (cachedUserId) {
    return getUserById(cachedUserId);
  }

  // Check database
  const session = await queryOne<Session>(
    'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()',
    [token]
  );

  if (!session) {
    return null;
  }

  // Refresh Redis cache
  await setSession(token, session.user_id);

  return getUserById(session.user_id);
}

export async function getUserById(userId: string): Promise<User | null> {
  return queryOne<User>(
    'SELECT id, email, role, email_notifications, created_at, updated_at FROM users WHERE id = $1',
    [userId]
  );
}

export async function updateUser(
  userId: string,
  updates: { email_notifications?: boolean }
): Promise<User | null> {
  const result = await query<User>(
    `UPDATE users
     SET email_notifications = COALESCE($2, email_notifications),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, email, role, email_notifications, created_at, updated_at`,
    [userId, updates.email_notifications]
  );
  return result[0] || null;
}

async function createSession(userId: string, token: string): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  await query(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  await setSession(token, userId);
}

// Clean up expired sessions
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await query<{ id: string }>(
    'DELETE FROM sessions WHERE expires_at < NOW() RETURNING id',
    []
  );
  return result.length;
}
