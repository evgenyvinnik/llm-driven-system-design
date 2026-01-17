/**
 * RabbitMQ client for async message processing.
 * Handles feed fanout, notifications, and background job processing.
 * Implements at-least-once delivery with idempotency tracking.
 *
 * @module utils/rabbitmq
 */
import amqplib, { Connection, Channel, ConsumeMessage } from 'amqplib';
import { logger } from './logger.js';
import { redis } from './redis.js';

let connection: Connection | null = null;
let channel: Channel | null = null;

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://linkedin:linkedin123@localhost:5672';

/**
 * Queue configuration with delivery semantics.
 */
export const QUEUES = {
  FEED_FANOUT: 'feed.fanout',
  NOTIFICATIONS: 'notifications',
  PYMK_COMPUTE: 'pymk.compute',
  SEARCH_INDEX: 'search.index',
  PROFILE_UPDATE: 'profile.update',
} as const;

/**
 * Exchange configuration for message routing.
 */
export const EXCHANGES = {
  DIRECT: 'linkedin.direct',
  FANOUT: 'linkedin.fanout',
  TOPIC: 'linkedin.topic',
} as const;

/**
 * Base message interface with idempotency support.
 */
export interface BaseMessage {
  idempotencyKey: string;
  timestamp: string;
  traceId?: string;
}

/**
 * Connection event - triggers PYMK recalculation and feed updates.
 */
export interface ConnectionEvent extends BaseMessage {
  type: 'connection.created' | 'connection.removed';
  userId: number;
  connectedUserId: number;
}

/**
 * Profile update event - triggers search index update.
 */
export interface ProfileUpdateEvent extends BaseMessage {
  type: 'profile.updated';
  userId: number;
  changedFields: string[];
}

/**
 * Post created event - triggers feed fanout to connections.
 */
export interface PostCreatedEvent extends BaseMessage {
  type: 'post.created';
  postId: number;
  authorId: number;
}

/**
 * Notification event - sends email/push notifications.
 */
export interface NotificationEvent extends BaseMessage {
  type: 'notification.connection_request' | 'notification.connection_accepted' | 'notification.post_liked' | 'notification.post_commented';
  recipientId: number;
  actorId: number;
  entityId?: number;
}

export type QueueMessage = ConnectionEvent | ProfileUpdateEvent | PostCreatedEvent | NotificationEvent;

/**
 * Connects to RabbitMQ and initializes exchanges and queues.
 * Creates dead letter queues for failed messages.
 *
 * @returns Promise resolving when connection is established
 */
export async function connectRabbitMQ(): Promise<void> {
  try {
    connection = await amqplib.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Set prefetch limit for backpressure
    await channel.prefetch(10);

    // Declare exchanges
    await channel.assertExchange(EXCHANGES.DIRECT, 'direct', { durable: true });
    await channel.assertExchange(EXCHANGES.FANOUT, 'fanout', { durable: true });
    await channel.assertExchange(EXCHANGES.TOPIC, 'topic', { durable: true });

    // Declare queues with dead letter configuration
    for (const queue of Object.values(QUEUES)) {
      await channel.assertQueue(queue, {
        durable: true,
        deadLetterExchange: EXCHANGES.DIRECT,
        deadLetterRoutingKey: `${queue}.dlq`,
      });

      // Dead letter queue
      await channel.assertQueue(`${queue}.dlq`, { durable: true });
      await channel.bindQueue(`${queue}.dlq`, EXCHANGES.DIRECT, `${queue}.dlq`);
    }

    // Bind queues to exchanges
    await channel.bindQueue(QUEUES.FEED_FANOUT, EXCHANGES.TOPIC, 'post.*');
    await channel.bindQueue(QUEUES.NOTIFICATIONS, EXCHANGES.TOPIC, 'notification.*');
    await channel.bindQueue(QUEUES.PYMK_COMPUTE, EXCHANGES.TOPIC, 'connection.*');
    await channel.bindQueue(QUEUES.SEARCH_INDEX, EXCHANGES.TOPIC, 'profile.*');
    await channel.bindQueue(QUEUES.PROFILE_UPDATE, EXCHANGES.TOPIC, 'profile.*');

    connection.on('error', (err) => {
      logger.error({ error: err }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed');
      connection = null;
      channel = null;
    });

    logger.info('Connected to RabbitMQ');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to RabbitMQ');
    throw error;
  }
}

/**
 * Publishes a message to a queue with idempotency key.
 *
 * @param queue - Target queue name
 * @param message - Message to publish
 * @returns Promise resolving when message is confirmed
 */
export async function publishToQueue<T extends QueueMessage>(
  queue: string,
  message: T
): Promise<void> {
  if (!channel) {
    logger.warn('RabbitMQ not connected, message dropped');
    return;
  }

  try {
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      messageId: message.idempotencyKey,
      timestamp: Date.now(),
    });
    logger.debug({ queue, messageType: message.type }, 'Message published');
  } catch (error) {
    logger.error({ error, queue, messageType: message.type }, 'Failed to publish message');
    throw error;
  }
}

/**
 * Publishes a message to an exchange with routing key.
 *
 * @param exchange - Target exchange name
 * @param routingKey - Routing key for message
 * @param message - Message to publish
 */
export async function publishToExchange<T extends QueueMessage>(
  exchange: string,
  routingKey: string,
  message: T
): Promise<void> {
  if (!channel) {
    logger.warn('RabbitMQ not connected, message dropped');
    return;
  }

  try {
    channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      messageId: message.idempotencyKey,
      timestamp: Date.now(),
    });
    logger.debug({ exchange, routingKey, messageType: message.type }, 'Message published to exchange');
  } catch (error) {
    logger.error({ error, exchange, routingKey, messageType: message.type }, 'Failed to publish to exchange');
    throw error;
  }
}

/**
 * Checks if a message has already been processed (idempotency).
 * Uses Redis with 24-hour TTL for tracking.
 *
 * @param idempotencyKey - Unique message identifier
 * @returns True if message was already processed
 */
export async function isMessageProcessed(idempotencyKey: string): Promise<boolean> {
  const key = `processed:${idempotencyKey}`;
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Marks a message as processed in Redis.
 *
 * @param idempotencyKey - Unique message identifier
 */
export async function markMessageProcessed(idempotencyKey: string): Promise<void> {
  const key = `processed:${idempotencyKey}`;
  await redis.setex(key, 86400, 'true'); // 24-hour TTL
}

/**
 * Consumer handler type.
 */
export type MessageHandler<T extends QueueMessage> = (message: T) => Promise<void>;

/**
 * Starts consuming messages from a queue with idempotency handling.
 *
 * @param queue - Queue name to consume from
 * @param handler - Message processing function
 */
export async function consumeQueue<T extends QueueMessage>(
  queue: string,
  handler: MessageHandler<T>
): Promise<void> {
  if (!channel) {
    logger.error('RabbitMQ not connected, cannot consume');
    return;
  }

  await channel.consume(queue, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    try {
      const message = JSON.parse(msg.content.toString()) as T;

      // Check idempotency
      if (await isMessageProcessed(message.idempotencyKey)) {
        logger.debug({ idempotencyKey: message.idempotencyKey }, 'Skipping duplicate message');
        channel?.ack(msg);
        return;
      }

      // Process message
      await handler(message);

      // Mark as processed
      await markMessageProcessed(message.idempotencyKey);

      channel?.ack(msg);
      logger.debug({ queue, messageType: message.type }, 'Message processed successfully');
    } catch (error) {
      logger.error({ error, queue }, 'Failed to process message');
      // Reject with requeue=false to send to DLQ
      channel?.nack(msg, false, false);
    }
  });

  logger.info({ queue }, 'Started consuming queue');
}

/**
 * Gets queue depth for monitoring.
 *
 * @param queue - Queue name to check
 * @returns Number of messages in queue
 */
export async function getQueueDepth(queue: string): Promise<number> {
  if (!channel) return 0;
  try {
    const { messageCount } = await channel.checkQueue(queue);
    return messageCount;
  } catch {
    return 0;
  }
}

/**
 * Closes RabbitMQ connection gracefully.
 */
export async function closeRabbitMQ(): Promise<void> {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    logger.info('RabbitMQ connection closed');
  } catch (error) {
    logger.error({ error }, 'Error closing RabbitMQ connection');
  }
}

/**
 * Checks if RabbitMQ is connected.
 */
export function isRabbitMQConnected(): boolean {
  return connection !== null && channel !== null;
}

export { channel, connection };
