import amqp, { Connection, Channel, ConsumeMessage } from 'amqplib';
import { logger } from './logger.js';

/**
 * RabbitMQ connection management for async processing.
 *
 * Used for:
 * - Decoupling Elasticsearch indexing from API responses
 * - Handling spikes in write traffic without blocking
 * - Enabling retry logic for failed index operations
 */

const RABBITMQ_URL: string =
  process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// Queue names
export const QUEUES = {
  BUSINESS_INDEX: 'business_index',
} as const;

// Message types
interface QueueMessage {
  type: string;
  businessId?: string;
  updates?: Record<string, unknown>;
  timestamp: string;
}

// Consumer options interface
interface ConsumeOptions {
  prefetch?: number;
}

// Connection state
let connection: Connection | null = null;
let channel: Channel | null = null;
let isShuttingDown = false;
let hasEverConnected = false;

/**
 * Connect to RabbitMQ and set up the channel.
 * Creates required queues if they don't exist.
 */
export async function connectQueue(): Promise<Channel> {
  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    hasEverConnected = true;

    // Declare queues (durable = survives broker restart)
    await channel.assertQueue(QUEUES.BUSINESS_INDEX, { durable: true });

    // Handle connection errors
    connection.on('error', (err: Error) => {
      if (!isShuttingDown) {
        logger.error({ err, component: 'queue' }, 'RabbitMQ connection error');
      }
    });

    connection.on('close', () => {
      if (!isShuttingDown && hasEverConnected) {
        logger.warn({ component: 'queue' }, 'RabbitMQ connection closed');
      }
    });

    logger.info(
      { component: 'queue', url: RABBITMQ_URL.replace(/:[^:@]+@/, ':****@') },
      'RabbitMQ connected'
    );
    return channel;
  } catch (err) {
    logger.error({ err, component: 'queue' }, 'Failed to connect to RabbitMQ');
    throw err;
  }
}

/**
 * Check if the queue connection is healthy.
 */
export function isQueueConnected(): boolean {
  return channel !== null && connection !== null;
}

/**
 * Publish a message to a queue.
 * Messages are persisted to disk (persistent: true) for durability.
 */
export async function publishToQueue(
  queue: string,
  message: QueueMessage
): Promise<boolean> {
  if (!channel) {
    logger.warn(
      { component: 'queue', queue },
      'Queue not connected, message dropped'
    );
    return false;
  }

  try {
    const content = Buffer.from(JSON.stringify(message));
    const sent = channel.sendToQueue(queue, content, { persistent: true });

    if (sent) {
      logger.debug(
        { component: 'queue', queue, messageType: message.type },
        'Message published'
      );
    } else {
      logger.warn(
        { component: 'queue', queue },
        'Message not published (queue full)'
      );
    }

    return sent;
  } catch (err) {
    logger.error(
      { err, component: 'queue', queue },
      'Failed to publish message'
    );
    return false;
  }
}

/**
 * Start consuming messages from a queue.
 */
export async function consumeQueue(
  queue: string,
  handler: (message: QueueMessage) => Promise<void>,
  options: ConsumeOptions = {}
): Promise<void> {
  if (!channel) {
    throw new Error('Queue not connected');
  }

  const { prefetch = 10 } = options;
  await channel.prefetch(prefetch);

  await channel.consume(queue, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    try {
      const content = JSON.parse(msg.content.toString()) as QueueMessage;
      await handler(content);
      channel!.ack(msg);
      logger.debug(
        { component: 'queue', queue, messageType: content.type },
        'Message processed'
      );
    } catch (err) {
      logger.error(
        { err, component: 'queue', queue },
        'Failed to process message'
      );
      // Negative acknowledge - requeue the message for retry
      // In production, you might want dead-letter queues for failed messages
      channel!.nack(msg, false, true);
    }
  });

  logger.info({ component: 'queue', queue, prefetch }, 'Consumer started');
}

/**
 * Close the RabbitMQ connection gracefully.
 */
export async function closeQueue(): Promise<void> {
  isShuttingDown = true;

  if (channel) {
    try {
      await channel.close();
    } catch {
      // Channel might already be closed
    }
    channel = null;
  }

  if (connection) {
    try {
      await connection.close();
    } catch {
      // Connection might already be closed
    }
    connection = null;
  }

  logger.info({ component: 'queue' }, 'RabbitMQ connection closed');
}

/**
 * Publish a business index update event.
 * Used by routes to trigger async Elasticsearch updates.
 */
export async function publishBusinessIndexUpdate(
  businessId: string,
  updates: Record<string, unknown>
): Promise<boolean> {
  return publishToQueue(QUEUES.BUSINESS_INDEX, {
    type: 'update',
    businessId,
    updates,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Publish a full business reindex event.
 */
export async function publishBusinessReindex(
  businessId: string
): Promise<boolean> {
  return publishToQueue(QUEUES.BUSINESS_INDEX, {
    type: 'reindex',
    businessId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Publish a business deletion event.
 */
export async function publishBusinessDelete(
  businessId: string
): Promise<boolean> {
  return publishToQueue(QUEUES.BUSINESS_INDEX, {
    type: 'delete',
    businessId,
    timestamp: new Date().toISOString(),
  });
}
