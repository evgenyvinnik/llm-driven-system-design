/**
 * RabbitMQ Queue Module
 *
 * Async queues enable:
 * - Reliable notification delivery (at-least-once with acknowledgments)
 * - Decoupling of services (booking service doesn't wait for notifications)
 * - Backpressure handling (queue absorbs traffic spikes)
 * - Retry logic with dead-letter queues
 *
 * Delivery semantics:
 * - At-least-once: Messages are acknowledged only after processing
 * - Idempotency: Consumers track processed message IDs to handle redelivery
 */

import amqp, { ChannelModel, Channel, ConsumeMessage } from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import logger, { createModuleLogger } from './logger.js';
import { metrics } from './metrics.js';
import redisClient from '../redis.js';

const log = createModuleLogger('queue');

// Queue configuration
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://airbnb:airbnb_dev@localhost:5672';
const EXCHANGE_NAME = 'airbnb.events';
const DEAD_LETTER_EXCHANGE = 'airbnb.dlx';

// Queue definitions
export const QUEUES = {
  BOOKING_EVENTS: 'booking.events',
  NOTIFICATION_SEND: 'notification.send',
  HOST_ALERTS: 'host.alerts',
  SEARCH_REINDEX: 'search.reindex',
  ANALYTICS_EVENTS: 'analytics.events',
} as const;

// Event types
export const EVENT_TYPES = {
  BOOKING_CREATED: 'booking.created',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_COMPLETED: 'booking.completed',
  LISTING_UPDATED: 'listing.updated',
  AVAILABILITY_CHANGED: 'availability.changed',
  REVIEW_SUBMITTED: 'review.submitted',
  HOST_ALERT: 'host.alert',
} as const;

// Type definitions
interface QueueEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  data: unknown;
}

interface PublishOptions {
  eventId?: string;
  headers?: Record<string, unknown>;
}

interface ConsumerOptions {
  prefetch?: number;
  maxRetries?: number;
}

interface QueueStats {
  [queueName: string]: {
    messageCount?: number;
    consumerCount?: number;
    error?: string;
  };
}

interface Booking {
  id: number;
  listing_id: number;
  check_in: string;
  check_out: string;
  total_price: number;
  nights: number;
  guests: number;
}

interface Listing {
  id: number;
  title: string;
  host_id: number;
}

type MessageHandler = (event: QueueEvent, msg: ConsumeMessage) => Promise<void>;

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let isConnecting = false;

/**
 * Initialize RabbitMQ connection and channels
 */
export async function initQueue(): Promise<{ connection: ChannelModel; channel: Channel }> {
  if (connection && channel) {
    return { connection, channel };
  }

  if (isConnecting) {
    // Wait for ongoing connection attempt
    await new Promise(resolve => setTimeout(resolve, 100));
    return initQueue();
  }

  isConnecting = true;

  try {
    log.info('Connecting to RabbitMQ...');
    const conn = await amqp.connect(RABBITMQ_URL);
    const chan = await conn.createChannel();

    connection = conn;
    channel = chan;

    // Handle connection errors
    conn.on('error', (err) => {
      log.error({ error: err }, 'RabbitMQ connection error');
      connection = null;
      channel = null;
    });

    conn.on('close', () => {
      log.warn('RabbitMQ connection closed');
      connection = null;
      channel = null;
    });

    // Declare exchanges
    await chan.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
    await chan.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });

    // Declare queues with dead-letter configuration
    const queueOptions = {
      durable: true,
      deadLetterExchange: DEAD_LETTER_EXCHANGE,
      messageTtl: 86400000, // 24 hours
    };

    await chan.assertQueue(QUEUES.BOOKING_EVENTS, queueOptions);
    await chan.assertQueue(QUEUES.NOTIFICATION_SEND, queueOptions);
    await chan.assertQueue(QUEUES.HOST_ALERTS, queueOptions);
    await chan.assertQueue(QUEUES.SEARCH_REINDEX, { ...queueOptions, messageTtl: 3600000 }); // 1 hour
    await chan.assertQueue(QUEUES.ANALYTICS_EVENTS, { ...queueOptions, messageTtl: 3600000 });

    // Declare DLQ queues
    await chan.assertQueue('dlq.booking.events', { durable: true });
    await chan.assertQueue('dlq.notification.send', { durable: true });

    // Bind queues to exchange
    await chan.bindQueue(QUEUES.BOOKING_EVENTS, EXCHANGE_NAME, 'booking.*');
    await chan.bindQueue(QUEUES.NOTIFICATION_SEND, EXCHANGE_NAME, 'notification.*');
    await chan.bindQueue(QUEUES.HOST_ALERTS, EXCHANGE_NAME, 'host.*');
    await chan.bindQueue(QUEUES.SEARCH_REINDEX, EXCHANGE_NAME, 'listing.*');
    await chan.bindQueue(QUEUES.ANALYTICS_EVENTS, EXCHANGE_NAME, '*.created');
    await chan.bindQueue(QUEUES.ANALYTICS_EVENTS, EXCHANGE_NAME, '*.completed');

    // Bind DLQ
    await chan.bindQueue('dlq.booking.events', DEAD_LETTER_EXCHANGE, 'booking.*');
    await chan.bindQueue('dlq.notification.send', DEAD_LETTER_EXCHANGE, 'notification.*');

    log.info('RabbitMQ connected and queues initialized');
    isConnecting = false;

    return { connection: conn, channel: chan };
  } catch (error) {
    isConnecting = false;
    log.error({ error }, 'Failed to connect to RabbitMQ');
    throw error;
  }
}

/**
 * Publish an event to the exchange
 * @param eventType - Event type (routing key)
 * @param data - Event data
 * @param options - Publish options
 */
export async function publishEvent(eventType: string, data: unknown, options: PublishOptions = {}): Promise<string> {
  try {
    if (!channel) {
      await initQueue();
    }

    const eventId = options.eventId || uuidv4();
    const message = {
      eventId,
      eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    const publishOptions = {
      persistent: true,
      messageId: eventId,
      contentType: 'application/json',
      headers: {
        'x-retry-count': 0,
        ...options.headers,
      },
    };

    channel!.publish(
      EXCHANGE_NAME,
      eventType,
      Buffer.from(JSON.stringify(message)),
      publishOptions
    );

    metrics.queueMessagesPublished.inc({
      queue_name: eventType.split('.')[0],
      event_type: eventType,
    });

    log.info({ eventId, eventType }, 'Event published');

    return eventId;
  } catch (error) {
    log.error({ error, eventType }, 'Failed to publish event');
    throw error;
  }
}

/**
 * Start consuming messages from a queue
 * @param queueName - Queue to consume from
 * @param handler - Message handler function
 * @param options - Consumer options
 */
export async function startConsumer(queueName: string, handler: MessageHandler, options: ConsumerOptions = {}): Promise<void> {
  try {
    if (!channel) {
      await initQueue();
    }

    const prefetch = options.prefetch || 10;
    await channel!.prefetch(prefetch);

    log.info({ queueName, prefetch }, 'Starting consumer');

    channel!.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      const startTime = Date.now();

      try {
        const event = JSON.parse(msg.content.toString()) as QueueEvent;
        const eventId = event.eventId;
        const retryCount = (msg.properties.headers?.['x-retry-count'] as number) || 0;

        log.info({ eventId, eventType: event.eventType, retryCount }, 'Processing message');

        // Idempotency check - skip if already processed
        const processedKey = `processed:${eventId}`;
        const alreadyProcessed = await redisClient.get(processedKey);

        if (alreadyProcessed) {
          log.info({ eventId }, 'Message already processed, skipping');
          channel!.ack(msg);
          return;
        }

        // Process the message
        await handler(event, msg);

        // Mark as processed (TTL 7 days)
        await redisClient.setEx(processedKey, 604800, '1');

        channel!.ack(msg);

        const latency = (Date.now() - startTime) / 1000;
        metrics.queueMessagesConsumed.inc({
          queue_name: queueName,
          event_type: event.eventType,
          status: 'success',
        });
        metrics.queueMessageLatency.observe({ queue_name: queueName }, latency);

        log.info({ eventId, latencyMs: latency * 1000 }, 'Message processed successfully');
      } catch (error) {
        const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) || 0) + 1;
        const maxRetries = options.maxRetries || 3;

        log.error({ error, retryCount, maxRetries }, 'Failed to process message');

        metrics.queueMessagesConsumed.inc({
          queue_name: queueName,
          event_type: 'unknown',
          status: 'failure',
        });

        if (retryCount < maxRetries) {
          // Requeue with incremented retry count
          const delay = Math.min(5000 * Math.pow(2, retryCount), 60000); // Exponential backoff, max 60s
          log.info({ retryCount, delayMs: delay }, 'Scheduling retry');

          setTimeout(() => {
            channel!.nack(msg, false, true); // Requeue
          }, delay);
        } else {
          // Max retries exceeded, send to DLQ
          log.warn({ retryCount }, 'Max retries exceeded, sending to DLQ');
          channel!.nack(msg, false, false); // Don't requeue, send to DLQ
        }
      }
    });
  } catch (error) {
    log.error({ error, queueName }, 'Failed to start consumer');
    throw error;
  }
}

/**
 * Get queue statistics for monitoring
 */
export async function getQueueStats(): Promise<QueueStats> {
  if (!channel) {
    return {};
  }

  const stats: QueueStats = {};

  for (const queueName of Object.values(QUEUES)) {
    try {
      const info = await channel.checkQueue(queueName);
      stats[queueName] = {
        messageCount: info.messageCount,
        consumerCount: info.consumerCount,
      };
      metrics.queueDepth.set({ queue_name: queueName }, info.messageCount);
    } catch {
      stats[queueName] = { error: 'Queue not found' };
    }
  }

  return stats;
}

/**
 * Close the RabbitMQ connection
 */
export async function closeQueue(): Promise<void> {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
    if (connection) {
      await connection.close();
      connection = null;
    }
    log.info('RabbitMQ connection closed');
  } catch (error) {
    log.error({ error }, 'Error closing RabbitMQ connection');
  }
}

// Convenience functions for specific event types

/**
 * Publish booking created event
 */
export async function publishBookingCreated(booking: Booking, listing: Listing): Promise<string> {
  return publishEvent(EVENT_TYPES.BOOKING_CREATED, {
    booking,
    listing: {
      id: listing.id,
      title: listing.title,
      hostId: listing.host_id,
    },
  });
}

/**
 * Publish booking confirmed event
 */
export async function publishBookingConfirmed(booking: Booking): Promise<string> {
  return publishEvent(EVENT_TYPES.BOOKING_CONFIRMED, { booking });
}

/**
 * Publish booking cancelled event
 */
export async function publishBookingCancelled(booking: Booking, cancelledBy: string): Promise<string> {
  return publishEvent(EVENT_TYPES.BOOKING_CANCELLED, { booking, cancelledBy });
}

/**
 * Publish host alert
 */
export async function publishHostAlert(hostId: number, alertType: string, data: Record<string, unknown>): Promise<string> {
  return publishEvent(EVENT_TYPES.HOST_ALERT, {
    hostId,
    alertType,
    ...data,
  });
}

/**
 * Publish availability changed event
 */
export async function publishAvailabilityChanged(listingId: number | string, changes: Record<string, unknown>): Promise<string> {
  return publishEvent(EVENT_TYPES.AVAILABILITY_CHANGED, { listingId, changes });
}

export default {
  initQueue,
  publishEvent,
  startConsumer,
  getQueueStats,
  closeQueue,
  publishBookingCreated,
  publishBookingConfirmed,
  publishBookingCancelled,
  publishHostAlert,
  publishAvailabilityChanged,
  QUEUES,
  EVENT_TYPES,
};
