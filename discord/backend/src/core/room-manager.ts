/**
 * Room Manager Module
 *
 * Manages chat rooms with in-memory caching for fast lookups and
 * database persistence for durability. Handles room creation,
 * membership tracking, and room queries.
 *
 * Architecture:
 * - In-memory cache for room metadata (fast existence checks)
 * - In-memory membership tracking for online users only
 * - Database for persistence and offline member queries
 */

import type { Room, User, RoomInfo } from '../types/index.js';
import * as dbOps from '../db/index.js';
import { historyBuffer } from './history-buffer.js';
import { logger } from '../utils/logger.js';

/**
 * Manages chat rooms and their memberships.
 *
 * Combines in-memory state for performance with database persistence
 * for durability. The in-memory roomMembers map tracks only currently
 * online users for real-time features like /list.
 */
export class RoomManager {
  /** Cache of online user IDs per room (for quick membership checks) */
  private roomMembers: Map<string, Set<number>> = new Map();
  /** Cache of room metadata to avoid repeated DB queries */
  private roomCache: Map<string, Room> = new Map();

  /**
   * Create a new chat room.
   * Validates uniqueness, persists to database, and initializes caches.
   *
   * @param name - Room name (lowercase, alphanumeric)
   * @param createdBy - User ID of the creator
   * @returns The newly created room
   * @throws Error if room name already exists
   */
  async createRoom(name: string, createdBy: number): Promise<Room> {
    // Check if room already exists
    const existing = await dbOps.getRoomByName(name);
    if (existing) {
      throw new Error(`Room "${name}" already exists`);
    }

    const room = await dbOps.createRoom(name, createdBy);
    this.roomCache.set(name, room);
    this.roomMembers.set(name, new Set());
    historyBuffer.initRoom(name);

    logger.info({ name, createdBy }, 'Room created');
    return room;
  }

  /**
   * Get a room by name, using cache when available.
   *
   * @param name - Room name to look up
   * @returns The room if found, null otherwise
   */
  async getRoom(name: string): Promise<Room | null> {
    // Check cache first
    const cached = this.roomCache.get(name);
    if (cached) return cached;

    // Load from database
    const room = await dbOps.getRoomByName(name);
    if (room) {
      this.roomCache.set(name, room);
    }
    return room;
  }

  /**
   * List all rooms with their member counts.
   * Queries database for accurate counts (includes offline members).
   *
   * @returns Array of room info sorted by name
   */
  async listRooms(): Promise<RoomInfo[]> {
    return dbOps.getAllRooms();
  }

  /**
   * Add a user to a room.
   * Updates both database (for persistence) and in-memory state (for real-time).
   *
   * @param roomName - Name of the room to join
   * @param userId - ID of the user joining
   * @returns The room that was joined
   * @throws Error if room does not exist
   */
  async joinRoom(roomName: string, userId: number): Promise<Room> {
    const room = await this.getRoom(roomName);
    if (!room) {
      throw new Error(`Room "${roomName}" does not exist`);
    }

    // Add to database
    await dbOps.joinRoom(room.id, userId);

    // Update in-memory state
    if (!this.roomMembers.has(roomName)) {
      this.roomMembers.set(roomName, new Set());
    }
    this.roomMembers.get(roomName)!.add(userId);

    logger.debug({ roomName, userId }, 'User joined room');
    return room;
  }

  /**
   * Remove a user from a room.
   * Updates both database and in-memory state.
   *
   * @param roomName - Name of the room to leave
   * @param userId - ID of the user leaving
   * @returns True if user was in the room and removed
   */
  async leaveRoom(roomName: string, userId: number): Promise<boolean> {
    const room = await this.getRoom(roomName);
    if (!room) return false;

    // Remove from database
    await dbOps.leaveRoom(room.id, userId);

    // Update in-memory state
    const members = this.roomMembers.get(roomName);
    if (members) {
      members.delete(userId);
    }

    logger.debug({ roomName, userId }, 'User left room');
    return true;
  }

  /**
   * Remove a user from all rooms.
   * Called during disconnect cleanup.
   *
   * @param userId - ID of the user leaving all rooms
   */
  async leaveAllRooms(userId: number): Promise<void> {
    // Update in-memory state
    for (const [roomName, members] of this.roomMembers) {
      members.delete(userId);
    }

    // Update database
    await dbOps.leaveAllRooms(userId);
    logger.debug({ userId }, 'User left all rooms');
  }

  /**
   * Get IDs of online members in a room.
   * Only returns currently connected users (from in-memory state).
   *
   * @param roomName - Name of the room
   * @returns Array of online user IDs
   */
  getOnlineMembers(roomName: string): number[] {
    const members = this.roomMembers.get(roomName);
    return members ? Array.from(members) : [];
  }

  /**
   * Get all members of a room (including offline).
   * Queries database for complete membership list.
   *
   * @param roomName - Name of the room
   * @returns Array of all member users
   */
  async getAllMembers(roomName: string): Promise<User[]> {
    const room = await this.getRoom(roomName);
    if (!room) return [];
    return dbOps.getRoomMembers(room.id);
  }

  /**
   * Check if a user is currently online in a room.
   *
   * @param roomName - Name of the room
   * @param userId - ID of the user to check
   * @returns True if user is online in the room
   */
  isUserInRoom(roomName: string, userId: number): boolean {
    const members = this.roomMembers.get(roomName);
    return members ? members.has(userId) : false;
  }

  /**
   * Check if a room exists.
   *
   * @param name - Room name to check
   * @returns True if room exists
   */
  async roomExists(name: string): Promise<boolean> {
    const room = await this.getRoom(name);
    return room !== null;
  }

  /**
   * Initialize in-memory membership for a reconnecting user.
   * Loads user's room memberships from database into memory.
   *
   * @param userId - ID of the user to initialize
   */
  async initUserRooms(userId: number): Promise<void> {
    const rooms = await dbOps.getUserRooms(userId);
    for (const room of rooms) {
      if (!this.roomMembers.has(room.name)) {
        this.roomMembers.set(room.name, new Set());
      }
      this.roomMembers.get(room.name)!.add(userId);
    }
  }

  /**
   * Clear all in-memory state.
   * Used in testing to reset between tests.
   */
  clear(): void {
    this.roomMembers.clear();
    this.roomCache.clear();
  }
}

/** Singleton instance of the room manager */
export const roomManager = new RoomManager();
export default roomManager;
