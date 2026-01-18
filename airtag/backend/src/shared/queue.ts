import amqplib, { Connection, Channel, ConsumeMessage } from 'amqplib';
import { createComponentLogger } from './logger.js';
import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from './metrics.js';

/**
 * RabbitMQ queue module for async location processing.
 *
 * WHY RABBITMQ FOR LOCATION PROCESSING:
 * - Decouples location report ingestion from processing
 * - Enables horizontal scaling of workers
 * - Provides message durability for reliability
 * - Allows rate limiting of downstream systems
 *
 * QUEUE TOPOLOGY:
 * - location-reports: Encrypted location reports from finder devices
 * - notifications: Device found notifications to deliver to owners
 *
 * RELIABILITY:
 * - Persistent messages survive broker restarts
 * - Manual acknowledgment ensures at-least-once delivery
 * - Dead letter exchange for failed messages
 */

const log = createComponentLogger('queue');

// Queue names
export const QUEUES = {
  LOCATION_REPORTS: 'location-reports',
  NOTIFICATIONS: 'notifications',
} as const;

// Connection configuration
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

// Connection state
let connection: Connection | null = null;
let channel: Channel | null = null;
let connecting = false;

// Prometheus metrics for queue operations
export const queueMessagesPublished = new Counter({
  name: 'queue_messages_published_total',
  help: 'Total number of messages published to queues',
  labelNames: ['queue', 'status'] as const,
  registers: [metricsRegistry],
});

export const queueMessagesConsumed = new Counter({
  name: 'queue_messages_consumed_total',
  help: 'Total number of messages consumed from queues',
  labelNames: ['queue', 'status'] as const,
  registers: [metricsRegistry],
});

export const queueProcessingDuration = new Histogram({
  name: 'queue_processing_duration_seconds',
  help: 'Duration of message processing in seconds',
  labelNames: ['queue'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

/**
 * Connect to RabbitMQ and create a channel.
 * Implements connection pooling and automatic reconnection.
 *
 * @returns The AMQP channel for queue operations
 */
export async function getChannel(): Promise<Channel> {
  if (channel) {
    return channel;
  }

  if (connecting) {
    // Wait for existing connection attempt
    await new Promise((resolve) => setTimeout(resolve, 100));
    return getChannel();
  }

  connecting = true;

  try {
    log.info({ url: RABBITMQ_URL.replace(/\/\/.*@/, '//***@') }, 'Connecting to RabbitMQ');

    const conn = await amqplib.connect(RABBITMQ_URL);
    connection = conn as unknown as Connection;
    const ch = await conn.createChannel();
    channel = ch;

    // Set prefetch for fair dispatch among workers
    await ch.prefetch(10);

    // Declare queues with durability
    await ch.assertQueue(QUEUES.LOCATION_REPORTS, {
      durable: true,
      arguments: {
        'x-message-ttl': 86400000, // 24 hour TTL
      },
    });

    await ch.assertQueue(QUEUES.NOTIFICATIONS, {
      durable: true,
      arguments: {
        'x-message-ttl': 3600000, // 1 hour TTL
      },
    });

    log.info('Connected to RabbitMQ, queues declared');

    // Handle connection errors
    conn.on('error', (err: Error) => {
      log.error({ error: err }, 'RabbitMQ connection error');
      channel = null;
      connection = null;
    });

    conn.on('close', () => {
      log.warn('RabbitMQ connection closed');
      channel = null;
      connection = null;
    });

    return ch;
  } catch (error) {
    log.error({ error }, 'Failed to connect to RabbitMQ');
    throw error;
  } finally {
    connecting = false;
  }
}

/**
 * Close the RabbitMQ connection gracefully.
 * Should be called during application shutdown.
 */
export async function closeConnection(): Promise<void> {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
    if (connection) {
      await (connection as unknown as { close(): Promise<void> }).close();
      connection = null;
    }
    log.info('RabbitMQ connection closed');
  } catch (error) {
    log.error({ error }, 'Error closing RabbitMQ connection');
  }
}

// ===== LOCATION REPORTS QUEUE =====

/**
 * Location report message structure.
 */
export interface LocationReportMessage {
  identifier_hash: string;
  encrypted_payload: {
    ephemeralPublicKey: string;
    iv: string;
    ciphertext: string;
    authTag: string;
  };
  reporter_region?: string;
  received_at: number;
}

/**
 * Publish a location report to the queue for async processing.
 * Returns immediately to minimize latency for reporting devices.
 *
 * @param data - The location report data
 * @returns True if published successfully
 */
export async function publishLocationReport(data: LocationReportMessage): Promise<boolean> {
  try {
    const ch = await getChannel();
    const message = Buffer.from(JSON.stringify(data));

    const published = ch.sendToQueue(QUEUES.LOCATION_REPORTS, message, {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
    });

    if (published) {
      queueMessagesPublished.inc({ queue: QUEUES.LOCATION_REPORTS, status: 'success' });
      log.debug(
        { identifierHash: data.identifier_hash, region: data.reporter_region },
        'Location report published to queue'
      );
    } else {
      queueMessagesPublished.inc({ queue: QUEUES.LOCATION_REPORTS, status: 'backpressure' });
      log.warn({ identifierHash: data.identifier_hash }, 'Queue backpressure, message buffered');
    }

    return published;
  } catch (error) {
    queueMessagesPublished.inc({ queue: QUEUES.LOCATION_REPORTS, status: 'error' });
    log.error({ error }, 'Failed to publish location report');
    throw error;
  }
}

/**
 * Message handler type for location reports.
 */
export type LocationReportHandler = (
  data: LocationReportMessage,
  ack: () => void,
  nack: (requeue?: boolean) => void
) => Promise<void>;

/**
 * Consume location reports from the queue.
 * Starts a consumer that processes messages with the provided handler.
 *
 * @param handler - Async function to process each message
 */
export async function consumeLocationReports(handler: LocationReportHandler): Promise<void> {
  const ch = await getChannel();

  log.info({ queue: QUEUES.LOCATION_REPORTS }, 'Starting location report consumer');

  await ch.consume(
    QUEUES.LOCATION_REPORTS,
    async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      const timer = queueProcessingDuration.startTimer({ queue: QUEUES.LOCATION_REPORTS });

      try {
        const data: LocationReportMessage = JSON.parse(msg.content.toString());

        await handler(
          data,
          () => {
            ch.ack(msg);
            queueMessagesConsumed.inc({ queue: QUEUES.LOCATION_REPORTS, status: 'success' });
            timer();
          },
          (requeue = false) => {
            ch.nack(msg, false, requeue);
            queueMessagesConsumed.inc({ queue: QUEUES.LOCATION_REPORTS, status: requeue ? 'requeued' : 'rejected' });
            timer();
          }
        );
      } catch (error) {
        log.error({ error, msgId: msg.properties.messageId }, 'Error processing location report');
        ch.nack(msg, false, false);
        queueMessagesConsumed.inc({ queue: QUEUES.LOCATION_REPORTS, status: 'error' });
        timer();
      }
    },
    { noAck: false }
  );
}

// ===== NOTIFICATIONS QUEUE =====

/**
 * Notification message structure.
 */
export interface NotificationMessage {
  user_id: string;
  device_id?: string;
  type: 'device_found' | 'unknown_tracker' | 'low_battery' | 'system';
  title: string;
  message?: string;
  data?: Record<string, unknown>;
  created_at: number;
}

/**
 * Publish a notification to the queue for async delivery.
 *
 * @param data - The notification data
 * @returns True if published successfully
 */
export async function publishNotification(data: NotificationMessage): Promise<boolean> {
  try {
    const ch = await getChannel();
    const message = Buffer.from(JSON.stringify(data));

    const published = ch.sendToQueue(QUEUES.NOTIFICATIONS, message, {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
    });

    if (published) {
      queueMessagesPublished.inc({ queue: QUEUES.NOTIFICATIONS, status: 'success' });
      log.debug({ userId: data.user_id, type: data.type }, 'Notification published to queue');
    } else {
      queueMessagesPublished.inc({ queue: QUEUES.NOTIFICATIONS, status: 'backpressure' });
      log.warn({ userId: data.user_id }, 'Queue backpressure, notification buffered');
    }

    return published;
  } catch (error) {
    queueMessagesPublished.inc({ queue: QUEUES.NOTIFICATIONS, status: 'error' });
    log.error({ error }, 'Failed to publish notification');
    throw error;
  }
}

/**
 * Message handler type for notifications.
 */
export type NotificationHandler = (
  data: NotificationMessage,
  ack: () => void,
  nack: (requeue?: boolean) => void
) => Promise<void>;

/**
 * Consume notifications from the queue.
 * Starts a consumer that processes messages with the provided handler.
 *
 * @param handler - Async function to process each notification
 */
export async function consumeNotifications(handler: NotificationHandler): Promise<void> {
  const ch = await getChannel();

  log.info({ queue: QUEUES.NOTIFICATIONS }, 'Starting notification consumer');

  await ch.consume(
    QUEUES.NOTIFICATIONS,
    async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      const timer = queueProcessingDuration.startTimer({ queue: QUEUES.NOTIFICATIONS });

      try {
        const data: NotificationMessage = JSON.parse(msg.content.toString());

        await handler(
          data,
          () => {
            ch.ack(msg);
            queueMessagesConsumed.inc({ queue: QUEUES.NOTIFICATIONS, status: 'success' });
            timer();
          },
          (requeue = false) => {
            ch.nack(msg, false, requeue);
            queueMessagesConsumed.inc({ queue: QUEUES.NOTIFICATIONS, status: requeue ? 'requeued' : 'rejected' });
            timer();
          }
        );
      } catch (error) {
        log.error({ error, msgId: msg.properties.messageId }, 'Error processing notification');
        ch.nack(msg, false, false);
        queueMessagesConsumed.inc({ queue: QUEUES.NOTIFICATIONS, status: 'error' });
        timer();
      }
    },
    { noAck: false }
  );
}

export default {
  getChannel,
  closeConnection,
  publishLocationReport,
  consumeLocationReports,
  publishNotification,
  consumeNotifications,
  QUEUES,
};
