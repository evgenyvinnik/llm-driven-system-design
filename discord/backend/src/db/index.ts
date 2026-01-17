import db from './connection.js';
import type { User, Room, Message, RoomMember, RoomInfo } from '../types/index.js';
import { logger } from '../utils/logger.js';

// User operations
export async function createUser(nickname: string): Promise<User> {
  const result = await db.query<User>(
    'INSERT INTO users (nickname) VALUES ($1) RETURNING id, nickname, created_at as "createdAt"',
    [nickname]
  );
  return result.rows[0];
}

export async function getUserByNickname(nickname: string): Promise<User | null> {
  const result = await db.query<User>(
    'SELECT id, nickname, created_at as "createdAt" FROM users WHERE nickname = $1',
    [nickname]
  );
  return result.rows[0] || null;
}

export async function getUserById(id: number): Promise<User | null> {
  const result = await db.query<User>(
    'SELECT id, nickname, created_at as "createdAt" FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getOrCreateUser(nickname: string): Promise<User> {
  const existing = await getUserByNickname(nickname);
  if (existing) return existing;
  return createUser(nickname);
}

export async function updateNickname(userId: number, newNickname: string): Promise<User | null> {
  const result = await db.query<User>(
    'UPDATE users SET nickname = $1 WHERE id = $2 RETURNING id, nickname, created_at as "createdAt"',
    [newNickname, userId]
  );
  return result.rows[0] || null;
}

// Room operations
export async function createRoom(name: string, createdBy: number): Promise<Room> {
  const result = await db.query<Room>(
    'INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id, name, created_by as "createdBy", created_at as "createdAt"',
    [name, createdBy]
  );
  return result.rows[0];
}

export async function getRoomByName(name: string): Promise<Room | null> {
  const result = await db.query<Room>(
    'SELECT id, name, created_by as "createdBy", created_at as "createdAt" FROM rooms WHERE name = $1',
    [name]
  );
  return result.rows[0] || null;
}

export async function getRoomById(id: number): Promise<Room | null> {
  const result = await db.query<Room>(
    'SELECT id, name, created_by as "createdBy", created_at as "createdAt" FROM rooms WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

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

export async function deleteRoom(name: string): Promise<boolean> {
  const result = await db.query('DELETE FROM rooms WHERE name = $1', [name]);
  return (result.rowCount ?? 0) > 0;
}

// Room membership operations
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

export async function leaveRoom(roomId: number, userId: number): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function leaveAllRooms(userId: number): Promise<void> {
  await db.query('DELETE FROM room_members WHERE user_id = $1', [userId]);
}

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

// Message operations
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

export async function cleanupOldMessages(): Promise<void> {
  try {
    await db.query('SELECT cleanup_old_messages()');
    logger.debug('Old messages cleaned up');
  } catch (error) {
    logger.error('Failed to cleanup old messages', { error });
  }
}

export * from './connection.js';
