import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../config/database.js';
import { setCache, getCache, deleteCache, cacheKeys } from '../config/redis.js';
import type { User } from '../types/index.js';

// Simple password hashing (use bcrypt in production)
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

interface SessionData {
  userId: string;
  role: string;
  expiresAt: string;
}

// Create a new user
export async function createUser(
  username: string,
  email: string,
  displayName: string,
  password: string,
  role: 'user' | 'admin' = 'user'
): Promise<User | null> {
  try {
    const user = await queryOne<User>(
      `INSERT INTO users (username, email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [username, email, displayName, hashPassword(password), role]
    );
    return user;
  } catch (error) {
    console.error('Error creating user:', error);
    return null;
  }
}

// Authenticate user
export async function authenticateUser(
  username: string,
  password: string
): Promise<User | null> {
  const user = await queryOne<User>(
    `SELECT * FROM users WHERE username = $1 AND password_hash = $2`,
    [username, hashPassword(password)]
  );
  return user;
}

// Create session
export async function createSession(userId: string, role: string): Promise<string> {
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  // Store in database
  await query(
    `INSERT INTO sessions (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );

  // Cache session
  const sessionData: SessionData = {
    userId,
    role,
    expiresAt: expiresAt.toISOString(),
  };
  await setCache(cacheKeys.userSession(token), sessionData, 24 * 60 * 60);

  return token;
}

// Validate session
export async function validateSession(token: string): Promise<SessionData | null> {
  // Check cache first
  const cached = await getCache<SessionData>(cacheKeys.userSession(token));
  if (cached) {
    if (new Date(cached.expiresAt) > new Date()) {
      return cached;
    }
    // Session expired
    await deleteSession(token);
    return null;
  }

  // Check database
  interface SessionRow {
    user_id: string;
    expires_at: Date;
    role: string;
  }

  const session = await queryOne<SessionRow>(
    `SELECT s.user_id, s.expires_at, u.role
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.token = $1`,
    [token]
  );

  if (!session || new Date(session.expires_at) < new Date()) {
    if (session) {
      await deleteSession(token);
    }
    return null;
  }

  const sessionData: SessionData = {
    userId: session.user_id,
    role: session.role,
    expiresAt: session.expires_at.toISOString(),
  };

  // Cache for future requests
  await setCache(cacheKeys.userSession(token), sessionData, 24 * 60 * 60);

  return sessionData;
}

// Delete session (logout)
export async function deleteSession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token = $1', [token]);
  await deleteCache(cacheKeys.userSession(token));
}

// Get user by ID
export async function getUserById(userId: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE id = $1', [userId]);
}

// Get user by username
export async function getUserByUsername(username: string): Promise<User | null> {
  return queryOne<User>('SELECT * FROM users WHERE username = $1', [username]);
}

// Get all users (for admin)
export async function getAllUsers(limit: number = 50, offset: number = 0): Promise<User[]> {
  return query<User>(
    `SELECT id, username, email, display_name, avatar_url, role, created_at, updated_at
     FROM users
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
}
