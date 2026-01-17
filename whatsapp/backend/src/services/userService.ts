import { pool } from '../db.js';
import { redis, KEYS } from '../redis.js';
import { User, PresenceInfo } from '../types/index.js';
import bcrypt from 'bcrypt';

export async function findUserByUsername(username: string): Promise<User | null> {
  const result = await pool.query(
    'SELECT id, username, display_name, profile_picture_url, created_at FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0] || null;
}

export async function findUserById(id: string): Promise<User | null> {
  const result = await pool.query(
    'SELECT id, username, display_name, profile_picture_url, created_at FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function validatePassword(username: string, password: string): Promise<User | null> {
  const result = await pool.query(
    'SELECT id, username, display_name, profile_picture_url, password_hash, created_at FROM users WHERE username = $1',
    [username]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    return null;
  }

  // Return user without password
  const { password_hash: _, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

export async function createUser(
  username: string,
  displayName: string,
  password: string
): Promise<User> {
  const passwordHash = await bcrypt.hash(password, 10);

  const result = await pool.query(
    `INSERT INTO users (username, display_name, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, username, display_name, profile_picture_url, created_at`,
    [username, displayName, passwordHash]
  );

  return result.rows[0];
}

export async function searchUsers(query: string, excludeUserId?: string): Promise<User[]> {
  const result = await pool.query(
    `SELECT id, username, display_name, profile_picture_url, created_at
     FROM users
     WHERE (username ILIKE $1 OR display_name ILIKE $1)
     ${excludeUserId ? 'AND id != $2' : ''}
     LIMIT 20`,
    excludeUserId ? [`%${query}%`, excludeUserId] : [`%${query}%`]
  );
  return result.rows;
}

export async function getAllUsers(excludeUserId?: string): Promise<User[]> {
  const result = await pool.query(
    `SELECT id, username, display_name, profile_picture_url, created_at
     FROM users
     ${excludeUserId ? 'WHERE id != $1' : ''}
     ORDER BY display_name
     LIMIT 100`,
    excludeUserId ? [excludeUserId] : []
  );
  return result.rows;
}

// Presence functions
export async function setUserPresence(
  userId: string,
  status: 'online' | 'offline',
  serverId?: string
): Promise<void> {
  const presence: PresenceInfo = {
    status,
    server: serverId,
    last_seen: Date.now(),
  };

  await redis.hset(KEYS.presence(userId), presence as unknown as Record<string, string>);

  if (status === 'online' && serverId) {
    // Set session mapping
    await redis.set(KEYS.session(userId), serverId);
  } else if (status === 'offline') {
    // Remove session mapping
    await redis.del(KEYS.session(userId));
  }
}

export async function getUserPresence(userId: string): Promise<PresenceInfo | null> {
  const presence = await redis.hgetall(KEYS.presence(userId));

  if (!presence || Object.keys(presence).length === 0) {
    return null;
  }

  return {
    status: presence.status as 'online' | 'offline',
    server: presence.server,
    last_seen: parseInt(presence.last_seen, 10),
  };
}

export async function getUserServer(userId: string): Promise<string | null> {
  return redis.get(KEYS.session(userId));
}
