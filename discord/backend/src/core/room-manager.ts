import type { Room, User, RoomInfo } from '../types/index.js';
import * as dbOps from '../db/index.js';
import { historyBuffer } from './history-buffer.js';
import { logger } from '../utils/logger.js';

export class RoomManager {
  // In-memory cache of room memberships (for online users only)
  private roomMembers: Map<string, Set<number>> = new Map();
  private roomCache: Map<string, Room> = new Map();

  /**
   * Create a new room
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

    logger.info('Room created', { name, createdBy });
    return room;
  }

  /**
   * Get room by name (with caching)
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
   * List all rooms with member counts
   */
  async listRooms(): Promise<RoomInfo[]> {
    return dbOps.getAllRooms();
  }

  /**
   * Add user to room (online presence only)
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

    logger.debug('User joined room', { roomName, userId });
    return room;
  }

  /**
   * Remove user from room
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

    logger.debug('User left room', { roomName, userId });
    return true;
  }

  /**
   * Remove user from all rooms
   */
  async leaveAllRooms(userId: number): Promise<void> {
    // Update in-memory state
    for (const [roomName, members] of this.roomMembers) {
      members.delete(userId);
    }

    // Update database
    await dbOps.leaveAllRooms(userId);
    logger.debug('User left all rooms', { userId });
  }

  /**
   * Get online members in a room
   */
  getOnlineMembers(roomName: string): number[] {
    const members = this.roomMembers.get(roomName);
    return members ? Array.from(members) : [];
  }

  /**
   * Get all members of a room (including offline from DB)
   */
  async getAllMembers(roomName: string): Promise<User[]> {
    const room = await this.getRoom(roomName);
    if (!room) return [];
    return dbOps.getRoomMembers(room.id);
  }

  /**
   * Check if user is in a room
   */
  isUserInRoom(roomName: string, userId: number): boolean {
    const members = this.roomMembers.get(roomName);
    return members ? members.has(userId) : false;
  }

  /**
   * Check if room exists
   */
  async roomExists(name: string): Promise<boolean> {
    const room = await this.getRoom(name);
    return room !== null;
  }

  /**
   * Initialize room membership for a user from database
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
   * Clear in-memory state (for testing)
   */
  clear(): void {
    this.roomMembers.clear();
    this.roomCache.clear();
  }
}

export const roomManager = new RoomManager();
export default roomManager;
