import type { Message } from '../types/index.js';
import * as dbOps from '../db/index.js';
import { logger } from '../utils/logger.js';

const MAX_MESSAGES_PER_ROOM = 10;

export class HistoryBuffer {
  private buffers: Map<string, Message[]> = new Map();
  private initialized = false;

  /**
   * Load history from database for all rooms on startup
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
      logger.error('Failed to load history from database', { error });
      throw error;
    }
  }

  /**
   * Add a message to the buffer and persist to database
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

    logger.debug('Message added to buffer', {
      roomName,
      userId,
      messageId: message.id,
    });

    return message;
  }

  /**
   * Get history for a room
   */
  getHistory(roomName: string): Message[] {
    return this.buffers.get(roomName) || [];
  }

  /**
   * Initialize buffer for a new room
   */
  initRoom(roomName: string): void {
    if (!this.buffers.has(roomName)) {
      this.buffers.set(roomName, []);
    }
  }

  /**
   * Remove buffer for a deleted room
   */
  removeRoom(roomName: string): void {
    this.buffers.delete(roomName);
  }

  /**
   * Clear all buffers (for testing)
   */
  clear(): void {
    this.buffers.clear();
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

export const historyBuffer = new HistoryBuffer();
export default historyBuffer;
