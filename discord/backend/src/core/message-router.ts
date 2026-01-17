import type { ChatMessage, PubSubMessage } from '../types/index.js';
import { connectionManager } from './connection-manager.js';
import { logger } from '../utils/logger.js';

export class MessageRouter {
  private instanceId: string;
  private pubsubHandler: ((msg: PubSubMessage) => void) | null = null;

  constructor() {
    this.instanceId = process.env.INSTANCE_ID || '1';
  }

  /**
   * Set the pub/sub handler for cross-instance messaging
   */
  setPubSubHandler(handler: (msg: PubSubMessage) => void): void {
    this.pubsubHandler = handler;
  }

  /**
   * Send a message to all members of a room (local instance only)
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
        logger.error('Failed to send message to session', {
          sessionId: session.sessionId,
          error,
        });
      }
    }

    logger.debug('Message routed to room', {
      roomName,
      recipientCount: sessions.length,
      excludeSessionId,
    });
  }

  /**
   * Send a message to all instances via pub/sub
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
   * Handle incoming pub/sub message from another instance
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
   * Send a system message to a room
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
   * Send a message to a specific session
   */
  sendToSession(sessionId: string, message: string): void {
    const session = connectionManager.getSession(sessionId);
    if (session) {
      try {
        session.sendMessage(message);
      } catch (error) {
        logger.error('Failed to send message to session', {
          sessionId,
          error,
        });
      }
    }
  }

  /**
   * Send a direct message to a user
   */
  sendDirectMessage(fromNickname: string, toUserId: number, content: string): void {
    const sessions = connectionManager.getSessionsByUserId(toUserId);
    const formatted = `[DM from ${fromNickname}] ${content}`;

    for (const session of sessions) {
      try {
        session.sendMessage(formatted);
      } catch (error) {
        logger.error('Failed to send DM to session', {
          sessionId: session.sessionId,
          error,
        });
      }
    }
  }

  /**
   * Format a chat message for display
   */
  private formatMessage(message: ChatMessage): string {
    const time = message.timestamp.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `[${message.room}] ${message.user}: ${message.content}`;
  }

  /**
   * Format a message as JSON (for HTTP/SSE clients)
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

export const messageRouter = new MessageRouter();
export default messageRouter;
