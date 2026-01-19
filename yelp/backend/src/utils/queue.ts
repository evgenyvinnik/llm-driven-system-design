import amqp from 'amqplib';
import { logger } from './logger.js';

/**
 * RabbitMQ connection management for async processing.
 *
 * Used for:
 * - Decoupling Elasticsearch indexing from API responses
 * - Handling spikes in write traffic without blocking
 * - Enabling retry logic for failed index operations
 */

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// Queue names
export const QUEUES = {
  BUSINESS_INDEX: 'business_index',
};

// Connection state
let connection = null;
let channel = null;
let isShuttingDown = false;
let hasEverConnected = false;

/**
 * Connect to RabbitMQ and set up the channel.
 * Creates required queues if they don't exist.
 */
export async function connectQueue() {
  try {
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    hasEverConnected = true;

    // Declare queues (durable = survives broker restart)
    await channel.assertQueue(QUEUES.BUSINESS_INDEX, { durable: true });

    // Handle connection errors
    connection.on('error', (err) => {
      if (!isShuttingDown) {
        logger.error({ err, component: 'queue' }, 'RabbitMQ connection error');
      }
    });

    connection.on('close', () => {
      if (!isShuttingDown && hasEverConnected) {
        logger.warn({ component: 'queue' }, 'RabbitMQ connection closed');
      }
    });

    logger.info({ component: 'queue', url: RABBITMQ_URL.replace(/:[^:@]+@/, ':****@') }, 'RabbitMQ connected');
    return channel;
  } catch (err) {
    logger.error({ err, component: 'queue' }, 'Failed to connect to RabbitMQ');
    throw err;
  }
}

/**
 * Check if the queue connection is healthy.
 */
export function isQueueConnected() {
  return channel !== null && connection !== null;
}

/**
 * Publish a message to a queue.
 * Messages are persisted to disk (persistent: true) for durability.
 *
 * @param {string} queue - Queue name from QUEUES
 * @param {object} message - Message payload (will be JSON stringified)
 */
export async function publishToQueue(queue, message) {
  if (!channel) {
    logger.warn({ component: 'queue', queue }, 'Queue not connected, message dropped');
    return false;
  }

  try {
    const content = Buffer.from(JSON.stringify(message));
    const sent = channel.sendToQueue(queue, content, { persistent: true });

    if (sent) {
      logger.debug({ component: 'queue', queue, messageType: message.type }, 'Message published');
    } else {
      logger.warn({ component: 'queue', queue }, 'Message not published (queue full)');
    }

    return sent;
  } catch (err) {
    logger.error({ err, component: 'queue', queue }, 'Failed to publish message');
    return false;
  }
}

/**
 * Start consuming messages from a queue.
 *
 * @param {string} queue - Queue name from QUEUES
 * @param {function} handler - Async function to process each message
 * @param {object} options - Consumer options
 * @param {number} options.prefetch - Max unacknowledged messages (default: 10)
 */
export async function consumeQueue(queue, handler, options = {}) {
  if (!channel) {
    throw new Error('Queue not connected');
  }

  const { prefetch = 10 } = options;
  await channel.prefetch(prefetch);

  await channel.consume(queue, async (msg) => {
    if (!msg) return;

    try {
      const content = JSON.parse(msg.content.toString());
      await handler(content);
      channel.ack(msg);
      logger.debug({ component: 'queue', queue, messageType: content.type }, 'Message processed');
    } catch (err) {
      logger.error({ err, component: 'queue', queue }, 'Failed to process message');
      // Negative acknowledge - requeue the message for retry
      // In production, you might want dead-letter queues for failed messages
      channel.nack(msg, false, true);
    }
  });

  logger.info({ component: 'queue', queue, prefetch }, 'Consumer started');
}

/**
 * Close the RabbitMQ connection gracefully.
 */
export async function closeQueue() {
  isShuttingDown = true;

  if (channel) {
    try {
      await channel.close();
    } catch (err) {
      // Channel might already be closed
    }
    channel = null;
  }

  if (connection) {
    try {
      await connection.close();
    } catch (err) {
      // Connection might already be closed
    }
    connection = null;
  }

  logger.info({ component: 'queue' }, 'RabbitMQ connection closed');
}

/**
 * Publish a business index update event.
 * Used by routes to trigger async Elasticsearch updates.
 *
 * @param {string} businessId - Business ID to update
 * @param {object} updates - Fields to update in Elasticsearch
 */
export async function publishBusinessIndexUpdate(businessId, updates) {
  return publishToQueue(QUEUES.BUSINESS_INDEX, {
    type: 'update',
    businessId,
    updates,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Publish a full business reindex event.
 *
 * @param {string} businessId - Business ID to reindex
 */
export async function publishBusinessReindex(businessId) {
  return publishToQueue(QUEUES.BUSINESS_INDEX, {
    type: 'reindex',
    businessId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Publish a business deletion event.
 *
 * @param {string} businessId - Business ID to remove from index
 */
export async function publishBusinessDelete(businessId) {
  return publishToQueue(QUEUES.BUSINESS_INDEX, {
    type: 'delete',
    businessId,
    timestamp: new Date().toISOString(),
  });
}
