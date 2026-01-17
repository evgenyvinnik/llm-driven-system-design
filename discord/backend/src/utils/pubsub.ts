/**
 * Pub/Sub Manager Module
 *
 * Manages Redis pub/sub connections for cross-instance message routing.
 * When multiple Baby Discord instances are running, this module enables
 * messages to be delivered to users regardless of which instance they
 * are connected to.
 *
 * Architecture:
 * - Uses two Redis connections (required by Redis pub/sub protocol):
 *   - Publisher: For publishing messages to channels
 *   - Subscriber: For receiving messages from subscribed channels
 * - Each room maps to a Redis channel (room:roomName)
 * - Messages from our own instance are filtered out to prevent loops
 */

import Redis from 'ioredis';
import type { PubSubMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Manages Redis pub/sub for multi-instance messaging.
 *
 * Provides methods to subscribe/unsubscribe from room channels,
 * publish messages, and handle incoming messages from other instances.
 */
export class PubSubManager {
  /** Redis connection for publishing messages */
  private publisher: Redis | null = null;
  /** Redis connection for subscribing to channels */
  private subscriber: Redis | null = null;
  /** Unique identifier for this server instance */
  private instanceId: string;
  /** Set of currently subscribed channel names */
  private subscribedChannels: Set<string> = new Set();
  /** Callback for handling received messages */
  private messageHandler: ((msg: PubSubMessage) => void) | null = null;

  constructor() {
    this.instanceId = process.env.INSTANCE_ID || '1';
  }

  /**
   * Connect to Redis for pub/sub.
   * Creates separate connections for publishing and subscribing
   * (required by Redis when a connection is in subscriber mode).
   *
   * @throws Error if Redis connection fails
   */
  async connect(): Promise<void> {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    try {
      // Separate connections for publish and subscribe (Redis requirement)
      this.publisher = new Redis(redisUrl);
      this.subscriber = new Redis(redisUrl);

      // Handle connection events
      this.publisher.on('connect', () => {
        logger.info('Redis publisher connected');
      });

      this.subscriber.on('connect', () => {
        logger.info('Redis subscriber connected');
      });

      this.publisher.on('error', (err) => {
        logger.error({ error: err.message }, 'Redis publisher error');
      });

      this.subscriber.on('error', (err) => {
        logger.error({ error: err.message }, 'Redis subscriber error');
      });

      // Handle incoming messages
      this.subscriber.on('message', (channel, message) => {
        this.handleMessage(channel, message);
      });

      logger.info('PubSub manager connected');
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect to Redis');
      throw error;
    }
  }

  /**
   * Disconnect from Redis.
   * Gracefully closes both publisher and subscriber connections.
   */
  async disconnect(): Promise<void> {
    if (this.publisher) {
      await this.publisher.quit();
      this.publisher = null;
    }

    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }

    this.subscribedChannels.clear();
    logger.info('PubSub manager disconnected');
  }

  /**
   * Set the callback for handling incoming pub/sub messages.
   * Called when messages arrive from other instances.
   *
   * @param handler - Function to process incoming PubSubMessage objects
   */
  setMessageHandler(handler: (msg: PubSubMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Subscribe to a room's pub/sub channel.
   * Called when a user joins a room to receive messages from other instances.
   *
   * @param roomName - Name of the room to subscribe to
   */
  async subscribeToRoom(roomName: string): Promise<void> {
    if (!this.subscriber) {
      logger.warn('Cannot subscribe: Redis not connected');
      return;
    }

    const channel = `room:${roomName}`;
    if (this.subscribedChannels.has(channel)) {
      return; // Already subscribed
    }

    await this.subscriber.subscribe(channel);
    this.subscribedChannels.add(channel);
    logger.debug({ channel }, 'Subscribed to room channel');
  }

  /**
   * Unsubscribe from a room's pub/sub channel.
   * Called when the last local user leaves a room.
   *
   * @param roomName - Name of the room to unsubscribe from
   */
  async unsubscribeFromRoom(roomName: string): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    const channel = `room:${roomName}`;
    if (!this.subscribedChannels.has(channel)) {
      return;
    }

    await this.subscriber.unsubscribe(channel);
    this.subscribedChannels.delete(channel);
    logger.debug({ channel }, 'Unsubscribed from room channel');
  }

  /**
   * Publish a message to a room's pub/sub channel.
   * The message will be delivered to all other instances subscribed to this room.
   *
   * @param roomName - Name of the target room
   * @param message - The message to publish (includes instanceId for filtering)
   */
  async publishToRoom(roomName: string, message: PubSubMessage): Promise<void> {
    if (!this.publisher) {
      logger.warn('Cannot publish: Redis not connected');
      return;
    }

    const channel = `room:${roomName}`;
    const payload = JSON.stringify(message);

    await this.publisher.publish(channel, payload);
    logger.debug({ channel, type: message.type }, 'Published message to channel');
  }

  /**
   * Handle an incoming pub/sub message from Redis.
   * Filters out messages from our own instance and dispatches to handler.
   *
   * @param channel - The Redis channel name
   * @param message - The raw JSON message string
   */
  private handleMessage(channel: string, message: string): void {
    try {
      const parsed = JSON.parse(message) as PubSubMessage;

      // Ignore messages from our own instance
      if (parsed.instanceId === this.instanceId) {
        return;
      }

      logger.debug({
        channel,
        type: parsed.type,
        fromInstance: parsed.instanceId,
      }, 'Received pub/sub message');

      if (this.messageHandler) {
        this.messageHandler(parsed);
      }
    } catch (error) {
      logger.error({ channel, err: error }, 'Failed to parse pub/sub message');
    }
  }

  /**
   * Check if connected to Redis.
   *
   * @returns True if both publisher and subscriber are connected
   */
  isConnected(): boolean {
    return this.publisher !== null && this.subscriber !== null;
  }

  /**
   * Get list of currently subscribed channels.
   * Useful for debugging and monitoring.
   *
   * @returns Array of channel names
   */
  getSubscribedChannels(): string[] {
    return Array.from(this.subscribedChannels);
  }
}

/** Singleton instance of the pub/sub manager */
export const pubsubManager = new PubSubManager();
export default pubsubManager;
