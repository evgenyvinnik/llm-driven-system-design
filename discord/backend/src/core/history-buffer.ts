/**
 * History Buffer Module
 *
 * Implements a ring buffer for recent message history per room.
 * Provides fast in-memory access to the last N messages while
 * persisting messages to the database asynchronously.
 *
 * Design decisions:
 * - Ring buffer limits memory usage (10 messages per room)
 * - In-memory for fast reads (joining a room shows instant history)
 * - Database for persistence (survives restarts via loadFromDB)
 * - Trade-off: Possible message loss on crash (acceptable for learning)
 */

import type { Message } from '../types/index.js';
import * as dbOps from '../db/index.js';
import { logger } from '../utils/logger.js';

/** Maximum number of messages to keep in memory per room */
const MAX_MESSAGES_PER_ROOM = 10;

/**
 * Ring buffer for recent message history.
 *
 * Maintains the last 10 messages per room in memory for fast access.
 * When a user joins a room, they immediately see recent messages
 * without a database query (O(1) lookup vs O(N) query).
 */
export class HistoryBuffer {
  /** Map of room name to message array (ring buffer per room) */
  private buffers: Map<string, Message[]> = new Map();
  /** Whether history has been loaded from database */
  private initialized = false;

  /**
   * Load message history from database for all existing rooms.
   * Should be called once at startup before accepting connections.
   *
   * @throws Error if database query fails
   */
  async loadFromDB(): Promise<void> {
    try {
      const rooms = await dbOps.getAllRooms();

      for (const room of rooms) {
        const roomData = await dbOps.getRoomByName(room.name);
        if (roomData) {
          const messages = await dbOps.getRecentMessages(
            roomData.id,
            MAX_MESSAGES_PER_ROOM
          );
          this.buffers.set(room.name, messages);
          logger.debug(`Loaded ${messages.length} messages for room: ${room.name}`);
        }
      }

      this.initialized = true;
      logger.info('History buffer initialized from database');
    } catch (error) {
      logger.error({ err: error }, 'Failed to load history from database');
      throw error;
    }
  }

  /**
   * Add a new message to the buffer and persist to database.
   * The message is saved to DB first (for the generated ID), then
   * added to the in-memory buffer with ring buffer behavior.
   *
   * @param roomName - Name of the room
   * @param roomId - Database ID of the room
   * @param userId - Database ID of the sender
   * @param nickname - Sender's display name
   * @param content - Message text
   * @returns The saved message with database ID and timestamp
   */
  async addMessage(
    roomName: string,
    roomId: number,
    userId: number,
    nickname: string,
    content: string
  ): Promise<Message> {
    // Get or create buffer for room
    let buffer = this.buffers.get(roomName);
    if (!buffer) {
      buffer = [];
      this.buffers.set(roomName, buffer);
    }

    // Persist to database (fire-and-forget for speed, but we await for message ID)
    const savedMessage = await dbOps.saveMessage(roomId, userId, content);

    // Create message object with denormalized fields
    const message: Message = {
      ...savedMessage,
      nickname,
      roomName,
    };

    // Add to buffer
    buffer.push(message);

    // Maintain ring buffer size
    if (buffer.length > MAX_MESSAGES_PER_ROOM) {
      buffer.shift(); // Remove oldest message
    }

    logger.debug({ roomName, userId, messageId: message.id }, 'Message added to buffer');

    return message;
  }

  /**
   * Get the message history for a room.
   * Returns messages in chronological order (oldest first).
   *
   * @param roomName - Name of the room
   * @returns Array of recent messages, or empty array if no history
   */
  getHistory(roomName: string): Message[] {
    return this.buffers.get(roomName) || [];
  }

  /**
   * Initialize an empty buffer for a newly created room.
   *
   * @param roomName - Name of the new room
   */
  initRoom(roomName: string): void {
    if (!this.buffers.has(roomName)) {
      this.buffers.set(roomName, []);
    }
  }

  /**
   * Remove the buffer for a deleted room.
   * Frees memory when a room is removed.
   *
   * @param roomName - Name of the room to remove
   */
  removeRoom(roomName: string): void {
    this.buffers.delete(roomName);
  }

  /**
   * Clear all buffers.
   * Used in testing to reset state between tests.
   */
  clear(): void {
    this.buffers.clear();
  }

  /**
   * Check if the buffer has been initialized from database.
   *
   * @returns True if loadFromDB has completed
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/** Singleton instance of the history buffer */
export const historyBuffer = new HistoryBuffer();
export default historyBuffer;
