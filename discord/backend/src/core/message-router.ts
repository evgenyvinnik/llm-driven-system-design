/**
 * Message Router Module
 *
 * Routes messages between users within rooms and across server instances.
 * Handles local delivery (to sessions on this instance) and pub/sub
 * publishing for multi-instance deployments.
 *
 * Key responsibilities:
 * - Send messages to all sessions in a room
 * - Broadcast messages across instances via pub/sub
 * - Handle incoming pub/sub messages from other instances
 * - Format messages for display (text for TCP, JSON for HTTP)
 */

import type { ChatMessage, PubSubMessage } from '../types/index.js';
import { connectionManager } from './connection-manager.js';
import { logger } from '../utils/logger.js';

/**
 * Routes messages to room members and across server instances.
 *
 * The router decouples message sending from the chat handler, allowing
 * different delivery mechanisms (local sockets, SSE, pub/sub) to be
 * used transparently.
 */
export class MessageRouter {
  /** Unique identifier for this server instance */
  private instanceId: string;
  /** Callback to publish messages to Redis for cross-instance delivery */
  private pubsubHandler: ((msg: PubSubMessage) => void) | null = null;

  constructor() {
    this.instanceId = process.env.INSTANCE_ID || '1';
  }

  /**
   * Set the pub/sub handler for cross-instance messaging.
   * Called during startup to wire up Redis pub/sub.
   *
   * @param handler - Callback that publishes messages to Redis
   */
  setPubSubHandler(handler: (msg: PubSubMessage) => void): void {
    this.pubsubHandler = handler;
  }

  /**
   * Send a message to all members of a room on this instance only.
   * Does not publish to pub/sub - use broadcastToRoom for that.
   *
   * @param roomName - Target room name
   * @param message - Message to send
   * @param excludeSessionId - Optional session to skip (usually the sender)
   */
  sendToRoom(
    roomName: string,
    message: ChatMessage,
    excludeSessionId?: string
  ): void {
    const sessions = connectionManager.getSessionsInRoom(roomName);

    const formatted = this.formatMessage(message);

    for (const session of sessions) {
      if (excludeSessionId && session.sessionId === excludeSessionId) {
        continue;
      }

      try {
        session.sendMessage(formatted);
      } catch (error) {
        logger.error({ sessionId: session.sessionId, err: error }, 'Failed to send message to session');
      }
    }

    logger.debug({ roomName, recipientCount: sessions.length, excludeSessionId }, 'Message routed to room');
  }

  /**
   * Broadcast a message to all instances via pub/sub.
   * First sends to local sessions, then publishes for other instances.
   *
   * @param roomName - Target room name
   * @param message - Message to broadcast
   * @param excludeSessionId - Optional session to skip locally
   */
  broadcastToRoom(
    roomName: string,
    message: ChatMessage,
    excludeSessionId?: string
  ): void {
    // First, send to local sessions
    this.sendToRoom(roomName, message, excludeSessionId);

    // Then, publish to pub/sub for other instances
    if (this.pubsubHandler) {
      const pubsubMsg: PubSubMessage = {
        type: 'chat',
        instanceId: this.instanceId,
        payload: message,
        room: roomName,
        timestamp: Date.now(),
      };
      this.pubsubHandler(pubsubMsg);
    }
  }

  /**
   * Handle an incoming pub/sub message from another instance.
   * Ignores messages from our own instance to prevent loops.
   *
   * @param msg - The pub/sub message received from Redis
   */
  handlePubSubMessage(msg: PubSubMessage): void {
    // Ignore messages from our own instance
    if (msg.instanceId === this.instanceId) {
      return;
    }

    if (msg.type === 'chat') {
      const chatMsg = msg.payload as ChatMessage;
      this.sendToRoom(msg.room, chatMsg);
    }
  }

  /**
   * Send a system message to a room.
   * Used for join/leave notifications and announcements.
   *
   * @param roomName - Target room name
   * @param content - System message text
   */
  sendSystemMessage(roomName: string, content: string): void {
    const message: ChatMessage = {
      room: roomName,
      user: 'system',
      content,
      timestamp: new Date(),
    };

    this.sendToRoom(roomName, message);

    // Broadcast system messages too
    if (this.pubsubHandler) {
      const pubsubMsg: PubSubMessage = {
        type: 'system',
        instanceId: this.instanceId,
        payload: { message: content },
        room: roomName,
        timestamp: Date.now(),
      };
      this.pubsubHandler(pubsubMsg);
    }
  }

  /**
   * Send a message directly to a specific session.
   * Used for command responses and errors.
   *
   * @param sessionId - Target session ID
   * @param message - Message string to send
   */
  sendToSession(sessionId: string, message: string): void {
    const session = connectionManager.getSession(sessionId);
    if (session) {
      try {
        session.sendMessage(message);
      } catch (error) {
        logger.error({ sessionId, err: error }, 'Failed to send message to session');
      }
    }
  }

  /**
   * Send a direct message to all sessions of a user.
   * DMs go to all user sessions (browser, netcat, etc).
   *
   * @param fromNickname - Sender's nickname for display
   * @param toUserId - Recipient's user ID
   * @param content - Message content
   */
  sendDirectMessage(fromNickname: string, toUserId: number, content: string): void {
    const sessions = connectionManager.getSessionsByUserId(toUserId);
    const formatted = `[DM from ${fromNickname}] ${content}`;

    for (const session of sessions) {
      try {
        session.sendMessage(formatted);
      } catch (error) {
        logger.error({ sessionId: session.sessionId, err: error }, 'Failed to send DM to session');
      }
    }
  }

  /**
   * Format a chat message for text display (TCP clients).
   *
   * @param message - The chat message to format
   * @returns Formatted string like "[room] user: content"
   */
  private formatMessage(message: ChatMessage): string {
    const time = message.timestamp.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `[${message.room}] ${message.user}: ${message.content}`;
  }

  /**
   * Format a message as JSON for HTTP/SSE clients.
   *
   * @param message - The chat message to format
   * @returns JSON string representation
   */
  formatMessageJson(message: ChatMessage): string {
    return JSON.stringify({
      room: message.room,
      user: message.user,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
      messageId: message.messageId,
    });
  }
}

/** Singleton instance of the message router */
export const messageRouter = new MessageRouter();
export default messageRouter;
