/**
 * Database Operations Module
 *
 * Provides high-level database operations for users, rooms, memberships, and messages.
 * All functions use parameterized queries to prevent SQL injection.
 * Column names are aliased to match TypeScript interface conventions (snake_case to camelCase).
 */

import db from './connection.js';
import type { User, Room, Message, RoomMember, RoomInfo } from '../types/index.js';

// Lazy logger initialization to avoid circular dependencies
let logger: any = null;
async function getLogger() {
  if (!logger) {
    const mod = await import('../utils/logger.js');
    logger = mod.dbLogger || mod.logger;
  }
  return logger;
}

// ============================================================================
// User Operations
// ============================================================================

/**
 * Create a new user with the given nickname.
 *
 * @param nickname - Unique display name for the user
 * @returns The newly created user record
 */
export async function createUser(nickname: string): Promise<User> {
  const result = await db.query<User>(
    'INSERT INTO users (nickname) VALUES ($1) RETURNING id, nickname, created_at as "createdAt"',
    [nickname]
  );
  return result.rows[0];
}

/**
 * Find a user by their nickname.
 *
 * @param nickname - The nickname to search for
 * @returns The user if found, null otherwise
 */
export async function getUserByNickname(nickname: string): Promise<User | null> {
  const result = await db.query<User>(
    'SELECT id, nickname, created_at as "createdAt" FROM users WHERE nickname = $1',
    [nickname]
  );
  return result.rows[0] || null;
}

/**
 * Find a user by their database ID.
 *
 * @param id - The user's database ID
 * @returns The user if found, null otherwise
 */
export async function getUserById(id: number): Promise<User | null> {
  const result = await db.query<User>(
    'SELECT id, nickname, created_at as "createdAt" FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get an existing user or create a new one with the given nickname.
 * Used during connection to handle returning users vs new users.
 *
 * @param nickname - The nickname to find or create
 * @returns The existing or newly created user
 */
export async function getOrCreateUser(nickname: string): Promise<User> {
  const existing = await getUserByNickname(nickname);
  if (existing) return existing;
  return createUser(nickname);
}

/**
 * Update a user's nickname.
 *
 * @param userId - ID of the user to update
 * @param newNickname - New nickname to set
 * @returns The updated user record, or null if user not found
 */
export async function updateNickname(userId: number, newNickname: string): Promise<User | null> {
  const result = await db.query<User>(
    'UPDATE users SET nickname = $1 WHERE id = $2 RETURNING id, nickname, created_at as "createdAt"',
    [newNickname, userId]
  );
  return result.rows[0] || null;
}

// ============================================================================
// Room Operations
// ============================================================================

/**
 * Create a new chat room.
 *
 * @param name - Unique room name (lowercase, alphanumeric)
 * @param createdBy - User ID of the room creator
 * @returns The newly created room record
 */
export async function createRoom(name: string, createdBy: number): Promise<Room> {
  const result = await db.query<Room>(
    'INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id, name, created_by as "createdBy", created_at as "createdAt"',
    [name, createdBy]
  );
  return result.rows[0];
}

/**
 * Find a room by its name.
 *
 * @param name - The room name to search for
 * @returns The room if found, null otherwise
 */
export async function getRoomByName(name: string): Promise<Room | null> {
  const result = await db.query<Room>(
    'SELECT id, name, created_by as "createdBy", created_at as "createdAt" FROM rooms WHERE name = $1',
    [name]
  );
  return result.rows[0] || null;
}

/**
 * Find a room by its database ID.
 *
 * @param id - The room's database ID
 * @returns The room if found, null otherwise
 */
export async function getRoomById(id: number): Promise<Room | null> {
  const result = await db.query<Room>(
    'SELECT id, name, created_by as "createdBy", created_at as "createdAt" FROM rooms WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get all rooms with their member counts.
 * Used for the /rooms command and room listings.
 *
 * @returns Array of room info sorted by name
 */
export async function getAllRooms(): Promise<RoomInfo[]> {
  const result = await db.query<RoomInfo>(
    `SELECT r.name, COUNT(rm.user_id) as "memberCount", r.created_at as "createdAt"
     FROM rooms r
     LEFT JOIN room_members rm ON r.id = rm.room_id
     GROUP BY r.id, r.name, r.created_at
     ORDER BY r.name`
  );
  return result.rows;
}

/**
 * Delete a room by name.
 *
 * @param name - The room name to delete
 * @returns True if a room was deleted, false if room not found
 */
export async function deleteRoom(name: string): Promise<boolean> {
  const result = await db.query('DELETE FROM rooms WHERE name = $1', [name]);
  return (result.rowCount ?? 0) > 0;
}

// ============================================================================
// Room Membership Operations
// ============================================================================

/**
 * Add a user to a room or update their join timestamp if already a member.
 * Uses ON CONFLICT to handle re-joining gracefully.
 *
 * @param roomId - ID of the room to join
 * @param userId - ID of the user joining
 * @returns The room membership record
 */
export async function joinRoom(roomId: number, userId: number): Promise<RoomMember> {
  const result = await db.query<RoomMember>(
    `INSERT INTO room_members (room_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (room_id, user_id) DO UPDATE SET joined_at = NOW()
     RETURNING room_id as "roomId", user_id as "userId", joined_at as "joinedAt"`,
    [roomId, userId]
  );
  return result.rows[0];
}

/**
 * Remove a user from a room.
 *
 * @param roomId - ID of the room to leave
 * @param userId - ID of the user leaving
 * @returns True if membership was removed, false if not a member
 */
export async function leaveRoom(roomId: number, userId: number): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Remove a user from all rooms.
 * Called during disconnect to clean up memberships.
 *
 * @param userId - ID of the user leaving all rooms
 */
export async function leaveAllRooms(userId: number): Promise<void> {
  await db.query('DELETE FROM room_members WHERE user_id = $1', [userId]);
}

/**
 * Get all members of a room.
 *
 * @param roomId - ID of the room
 * @returns Array of users who are members of the room
 */
export async function getRoomMembers(roomId: number): Promise<User[]> {
  const result = await db.query<User>(
    `SELECT u.id, u.nickname, u.created_at as "createdAt"
     FROM users u
     JOIN room_members rm ON u.id = rm.user_id
     WHERE rm.room_id = $1`,
    [roomId]
  );
  return result.rows;
}

/**
 * Get all rooms a user is a member of.
 *
 * @param userId - ID of the user
 * @returns Array of rooms the user belongs to
 */
export async function getUserRooms(userId: number): Promise<Room[]> {
  const result = await db.query<Room>(
    `SELECT r.id, r.name, r.created_by as "createdBy", r.created_at as "createdAt"
     FROM rooms r
     JOIN room_members rm ON r.id = rm.room_id
     WHERE rm.user_id = $1`,
    [userId]
  );
  return result.rows;
}

// ============================================================================
// Message Operations
// ============================================================================

/**
 * Save a new message to the database.
 *
 * @param roomId - ID of the room where the message was sent
 * @param userId - ID of the user who sent the message
 * @param content - Message text content
 * @returns The saved message record with generated ID and timestamp
 */
export async function saveMessage(
  roomId: number,
  userId: number,
  content: string
): Promise<Message> {
  const result = await db.query<Message>(
    `INSERT INTO messages (room_id, user_id, content)
     VALUES ($1, $2, $3)
     RETURNING id, room_id as "roomId", user_id as "userId", content, created_at as "createdAt"`,
    [roomId, userId, content]
  );
  return result.rows[0];
}

/**
 * Get the most recent messages in a room.
 * Results are returned in chronological order (oldest first).
 *
 * @param roomId - ID of the room
 * @param limit - Maximum number of messages to return (default: 10)
 * @returns Array of messages with user and room info
 */
export async function getRecentMessages(
  roomId: number,
  limit: number = 10
): Promise<Message[]> {
  const result = await db.query<Message>(
    `SELECT m.id, m.room_id as "roomId", m.user_id as "userId", m.content,
            m.created_at as "createdAt", u.nickname, r.name as "roomName"
     FROM messages m
     LEFT JOIN users u ON m.user_id = u.id
     LEFT JOIN rooms r ON m.room_id = r.id
     WHERE m.room_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [roomId, limit]
  );
  // Reverse to get chronological order
  return result.rows.reverse();
}

/**
 * Delete old messages using the database cleanup function.
 * Called periodically to manage storage.
 */
export async function cleanupOldMessages(): Promise<void> {
  try {
    await db.query('SELECT cleanup_old_messages()');
    const log = await getLogger();
    if (log) log.debug('Old messages cleaned up');
  } catch (error) {
    const log = await getLogger();
    if (log) log.error({ err: error }, 'Failed to cleanup old messages');
  }
}

export * from './connection.js';
