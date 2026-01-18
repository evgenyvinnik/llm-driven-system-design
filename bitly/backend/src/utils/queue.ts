import amqplib from 'amqplib';
import type { ChannelModel, Channel, ConsumeMessage } from 'amqplib';
import logger from './logger.js';

/**
 * RabbitMQ configuration for async messaging.
 * Used for decoupling click event recording from the redirect path.
 */
export const QUEUE_CONFIG = {
  url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  clickEventsQueue: 'click-events',
  prefetchCount: 10, // Process 10 messages at a time per worker
  reconnectDelay: 5000, // 5 seconds between reconnection attempts
};

/**
 * Click event data structure for queue messages.
 */
export interface ClickEventMessage {
  short_code: string;
  referrer?: string;
  user_agent?: string;
  ip_address?: string;
  device_type: string;
  timestamp: string;
}

/**
 * RabbitMQ connection state.
 * Manages a single connection and channel for the application.
 */
let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let isConnecting = false;

/**
 * Establishes connection to RabbitMQ and creates a channel.
 * Includes automatic reconnection logic and queue assertion.
 * @returns Promise resolving to true if connection succeeds, false otherwise
 */
export async function connectQueue(): Promise<boolean> {
  if (isConnecting) {
    logger.debug('Queue connection already in progress');
    return false;
  }

  if (channel && connection) {
    return true;
  }

  isConnecting = true;

  try {
    logger.info({ url: QUEUE_CONFIG.url.replace(/:[^:@]+@/, ':***@') }, 'Connecting to RabbitMQ');
    const conn = await amqplib.connect(QUEUE_CONFIG.url);
    connection = conn;

    conn.on('error', (err) => {
      logger.error({ err }, 'RabbitMQ connection error');
      channel = null;
      connection = null;
    });

    conn.on('close', () => {
      logger.warn('RabbitMQ connection closed, will reconnect');
      channel = null;
      connection = null;

      // Schedule reconnection
      setTimeout(() => {
        connectQueue().catch((err) => {
          logger.error({ err }, 'Failed to reconnect to RabbitMQ');
        });
      }, QUEUE_CONFIG.reconnectDelay);
    });

    const ch = await conn.createChannel();
    channel = ch;

    // Assert the click-events queue exists
    await ch.assertQueue(QUEUE_CONFIG.clickEventsQueue, {
      durable: true, // Queue survives broker restart
      arguments: {
        'x-message-ttl': 86400000, // Messages expire after 24 hours
      },
    });

    logger.info({ queue: QUEUE_CONFIG.clickEventsQueue }, 'RabbitMQ connected and queue asserted');
    isConnecting = false;
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to RabbitMQ');
    isConnecting = false;
    connection = null;
    channel = null;
    return false;
  }
}

/**
 * Returns the current RabbitMQ connection state.
 * Used by health check endpoints.
 */
export function isQueueConnected(): boolean {
  return connection !== null && channel !== null;
}

/**
 * Publishes a click event to the queue for async processing.
 * If queue is unavailable, logs a warning but does not block.
 * @param data - Click event data to publish
 * @returns Promise resolving to true if published, false otherwise
 */
export async function publishClickEvent(data: ClickEventMessage): Promise<boolean> {
  if (!channel) {
    logger.warn({ short_code: data.short_code }, 'Queue not connected, click event will not be queued');
    return false;
  }

  try {
    const message = Buffer.from(JSON.stringify(data));

    const sent = channel.sendToQueue(QUEUE_CONFIG.clickEventsQueue, message, {
      persistent: true, // Message survives broker restart
      contentType: 'application/json',
      timestamp: Date.now(),
    });

    if (sent) {
      logger.debug({ short_code: data.short_code }, 'Click event published to queue');
    } else {
      logger.warn({ short_code: data.short_code }, 'Queue buffer full, click event not published');
    }

    return sent;
  } catch (error) {
    logger.error({ err: error, short_code: data.short_code }, 'Failed to publish click event');
    return false;
  }
}

/**
 * Handler function type for processing click events from the queue.
 */
export type ClickEventHandler = (event: ClickEventMessage) => Promise<void>;

/**
 * Starts consuming click events from the queue.
 * Handles message acknowledgment and error recovery.
 * @param handler - Async function to process each click event
 */
export async function consumeClickEvents(handler: ClickEventHandler): Promise<void> {
  if (!channel) {
    throw new Error('Queue not connected. Call connectQueue() first.');
  }

  const ch = channel;

  // Set prefetch to limit concurrent processing
  await ch.prefetch(QUEUE_CONFIG.prefetchCount);

  await ch.consume(
    QUEUE_CONFIG.clickEventsQueue,
    async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      try {
        const event: ClickEventMessage = JSON.parse(msg.content.toString());

        logger.debug({ short_code: event.short_code }, 'Processing click event from queue');

        await handler(event);

        // Acknowledge message after successful processing
        ch.ack(msg);

        logger.debug({ short_code: event.short_code }, 'Click event processed and acknowledged');
      } catch (error) {
        logger.error({ err: error }, 'Failed to process click event');

        // Reject message and requeue it for retry
        // In production, consider using dead-letter queue after N retries
        ch.nack(msg, false, true);
      }
    },
    { noAck: false } // Manual acknowledgment
  );

  logger.info({ queue: QUEUE_CONFIG.clickEventsQueue }, 'Started consuming click events');
}

/**
 * Closes the RabbitMQ connection during graceful shutdown.
 * @returns Promise that resolves when the connection is closed
 */
export async function closeQueue(): Promise<void> {
  if (channel) {
    try {
      await channel.close();
    } catch {
      // Ignore close errors
    }
    channel = null;
  }

  if (connection) {
    try {
      await connection.close();
    } catch {
      // Ignore close errors
    }
    connection = null;
  }

  logger.info('RabbitMQ connection closed');
}
