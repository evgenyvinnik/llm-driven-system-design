import Redis from 'ioredis';
import type { PubSubMessage } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class PubSubManager {
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private instanceId: string;
  private subscribedChannels: Set<string> = new Set();
  private messageHandler: ((msg: PubSubMessage) => void) | null = null;

  constructor() {
    this.instanceId = process.env.INSTANCE_ID || '1';
  }

  /**
   * Connect to Redis for pub/sub
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
        logger.error('Redis publisher error', { error: err.message });
      });

      this.subscriber.on('error', (err) => {
        logger.error('Redis subscriber error', { error: err.message });
      });

      // Handle incoming messages
      this.subscriber.on('message', (channel, message) => {
        this.handleMessage(channel, message);
      });

      logger.info('PubSub manager connected');
    } catch (error) {
      logger.error('Failed to connect to Redis', { error });
      throw error;
    }
  }

  /**
   * Disconnect from Redis
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
   * Set the message handler callback
   */
  setMessageHandler(handler: (msg: PubSubMessage) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Subscribe to a room channel
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
    logger.debug('Subscribed to room channel', { channel });
  }

  /**
   * Unsubscribe from a room channel
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
    logger.debug('Unsubscribed from room channel', { channel });
  }

  /**
   * Publish a message to a room channel
   */
  async publishToRoom(roomName: string, message: PubSubMessage): Promise<void> {
    if (!this.publisher) {
      logger.warn('Cannot publish: Redis not connected');
      return;
    }

    const channel = `room:${roomName}`;
    const payload = JSON.stringify(message);

    await this.publisher.publish(channel, payload);
    logger.debug('Published message to channel', { channel, type: message.type });
  }

  /**
   * Handle incoming pub/sub message
   */
  private handleMessage(channel: string, message: string): void {
    try {
      const parsed = JSON.parse(message) as PubSubMessage;

      // Ignore messages from our own instance
      if (parsed.instanceId === this.instanceId) {
        return;
      }

      logger.debug('Received pub/sub message', {
        channel,
        type: parsed.type,
        fromInstance: parsed.instanceId,
      });

      if (this.messageHandler) {
        this.messageHandler(parsed);
      }
    } catch (error) {
      logger.error('Failed to parse pub/sub message', { channel, error });
    }
  }

  /**
   * Check if connected to Redis
   */
  isConnected(): boolean {
    return this.publisher !== null && this.subscriber !== null;
  }

  /**
   * Get list of subscribed channels
   */
  getSubscribedChannels(): string[] {
    return Array.from(this.subscribedChannels);
  }
}

export const pubsubManager = new PubSubManager();
export default pubsubManager;
