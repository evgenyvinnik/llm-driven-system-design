import { pool } from '../db.js';
import { redis, KEYS } from '../redis.js';
import { User, PresenceInfo } from '../types/index.js';
import bcrypt from 'bcrypt';

/**
 * Finds a user by their username.
 * Used during login and to check for existing usernames during registration.
 * @param username - The username to search for
 * @returns The user if found, null otherwise
 */
export async function findUserByUsername(username: string): Promise<User | null> {
  const result = await pool.query(
    'SELECT id, username, display_name, profile_picture_url, created_at FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0] || null;
}

/**
 * Finds a user by their unique ID.
 * Used to retrieve user details for session validation and profile display.
 * @param id - The user's UUID
 * @returns The user if found, null otherwise
 */
export async function findUserById(id: string): Promise<User | null> {
  const result = await pool.query(
    'SELECT id, username, display_name, profile_picture_url, created_at FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Validates a user's password during login.
 * Compares the provided password against the stored bcrypt hash.
 * @param username - The username attempting to log in
 * @param password - The plain-text password to validate
 * @returns The user (without password) if credentials are valid, null otherwise
 */
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

/**
 * Creates a new user account.
 * Hashes the password with bcrypt before storing.
 * @param username - Unique username for the new account
 * @param displayName - Human-readable display name
 * @param password - Plain-text password to be hashed
 * @returns The newly created user
 */
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

/**
 * Searches for users by username or display name.
 * Used for finding users to start new conversations with.
 * @param query - Search string to match against username and display_name
 * @param excludeUserId - Optional user ID to exclude from results (typically the current user)
 * @returns Array of matching users (max 20)
 */
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

/**
 * Retrieves all users in the system.
 * Used for displaying a user directory when no search query is provided.
 * @param excludeUserId - Optional user ID to exclude (typically the current user)
 * @returns Array of all users (max 100), ordered by display name
 */
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

/**
 * Updates a user's presence status in Redis.
 * Called when WebSocket connects (online) or disconnects (offline).
 * Also manages the session-to-server mapping for message routing.
 * @param userId - The user whose presence is being updated
 * @param status - 'online' or 'offline'
 * @param serverId - The server instance handling this user's WebSocket (for online status)
 */
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

/**
 * Retrieves a user's current presence information from Redis.
 * Used to display online/offline status and last seen time.
 * @param userId - The user whose presence to retrieve
 * @returns Presence info if available, null if user has never connected
 */
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

/**
 * Gets the server instance where a user is currently connected.
 * Essential for cross-server message routing in distributed deployments.
 * @param userId - The user to look up
 * @returns Server ID if user is online, null if offline
 */
export async function getUserServer(userId: string): Promise<string | null> {
  return redis.get(KEYS.session(userId));
}
