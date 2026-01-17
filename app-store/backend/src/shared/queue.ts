/**
 * @fileoverview RabbitMQ message queue client for async processing.
 * Provides message publishing with automatic retries, consumer setup,
 * dead letter queue support, and delivery semantics.
 */

import amqp from 'amqplib';
import type { ConsumeMessage, Options } from 'amqplib';
import { logger, logging } from './logger.js';
import { mqMessagesPublished, mqMessagesConsumed, mqProcessingDuration, mqQueueDepth } from './metrics.js';
import { v4 as uuid } from 'uuid';

// Use any for connection/channel since amqplib types are complex
/* eslint-disable @typescript-eslint/no-explicit-any */
type AmqpConnection = any;
type AmqpChannel = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// =============================================================================
// Configuration
// =============================================================================

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://appstore:appstore_pass@localhost:5672';

/**
 * Exchange and queue configuration for the App Store.
 */
export const QueueConfig = {
  exchanges: {
    events: 'app-store.events',      // Topic exchange for event fanout
    tasks: 'app-store.tasks',        // Direct exchange for task queues
    dlx: 'app-store.dlx',            // Dead letter exchange
  },
  queues: {
    downloadProcessing: 'download.processing',
    reviewProcessing: 'review.processing',
    searchReindex: 'search.reindex',
    payoutCalculation: 'payout.calculation',
    deadLetter: 'dead-letter',
  },
  routingKeys: {
    downloadCreated: 'download.created',
    reviewCreated: 'review.created',
    reviewUpdated: 'review.updated',
    appUpdated: 'app.updated',
    purchaseCompleted: 'purchase.completed',
  },
} as const;

// =============================================================================
// Connection Management
// =============================================================================

let connection: AmqpConnection = null;
let publishChannel: AmqpChannel = null;
let consumeChannel: AmqpChannel = null;
let isConnecting = false;
let connectionRetries = 0;
const MAX_RETRIES = 10;
const RETRY_DELAY = 5000;

/**
 * Connects to RabbitMQ and sets up channels.
 * Implements automatic reconnection on failure.
 */
export async function connectRabbitMQ(): Promise<void> {
  if (connection || isConnecting) return;

  isConnecting = true;

  try {
    logger.info({ url: RABBITMQ_URL.replace(/:[^:@]*@/, ':***@') }, 'Connecting to RabbitMQ');
    connection = await amqp.connect(RABBITMQ_URL);
    connectionRetries = 0;

    connection.on('error', (err: Error) => {
      logger.error({ error: err.message }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed, attempting reconnect');
      connection = null;
      publishChannel = null;
      consumeChannel = null;
      scheduleReconnect();
    });

    // Create channels
    publishChannel = await connection.createChannel();
    consumeChannel = await connection.createChannel();

    // Set up exchanges
    await publishChannel.assertExchange(QueueConfig.exchanges.events, 'topic', { durable: true });
    await publishChannel.assertExchange(QueueConfig.exchanges.tasks, 'direct', { durable: true });
    await publishChannel.assertExchange(QueueConfig.exchanges.dlx, 'direct', { durable: true });

    // Set up dead letter queue
    await publishChannel.assertQueue(QueueConfig.queues.deadLetter, {
      durable: true,
    });
    await publishChannel.bindQueue(
      QueueConfig.queues.deadLetter,
      QueueConfig.exchanges.dlx,
      '#'
    );

    // Set up processing queues with DLX
    const queueOptions: Options.AssertQueue = {
      durable: true,
      deadLetterExchange: QueueConfig.exchanges.dlx,
      messageTtl: 86400000, // 24 hours
    };

    await publishChannel.assertQueue(QueueConfig.queues.downloadProcessing, queueOptions);
    await publishChannel.bindQueue(
      QueueConfig.queues.downloadProcessing,
      QueueConfig.exchanges.events,
      QueueConfig.routingKeys.downloadCreated
    );

    await publishChannel.assertQueue(QueueConfig.queues.reviewProcessing, {
      ...queueOptions,
      messageTtl: 604800000, // 7 days for reviews
    });
    await publishChannel.bindQueue(
      QueueConfig.queues.reviewProcessing,
      QueueConfig.exchanges.events,
      'review.*'
    );

    await publishChannel.assertQueue(QueueConfig.queues.searchReindex, queueOptions);
    await publishChannel.bindQueue(
      QueueConfig.queues.searchReindex,
      QueueConfig.exchanges.events,
      'app.*'
    );

    await publishChannel.assertQueue(QueueConfig.queues.payoutCalculation, {
      ...queueOptions,
      messageTtl: 604800000, // 7 days for purchases
    });
    await publishChannel.bindQueue(
      QueueConfig.queues.payoutCalculation,
      QueueConfig.exchanges.events,
      QueueConfig.routingKeys.purchaseCompleted
    );

    logger.info('RabbitMQ connected and configured');
    isConnecting = false;
  } catch (error) {
    isConnecting = false;
    logger.error({ error: (error as Error).message }, 'Failed to connect to RabbitMQ');
    scheduleReconnect();
    throw error;
  }
}

/**
 * Schedules a reconnection attempt.
 */
function scheduleReconnect(): void {
  if (connectionRetries >= MAX_RETRIES) {
    logger.error('Max RabbitMQ reconnection attempts reached');
    return;
  }

  connectionRetries++;
  const delay = RETRY_DELAY * Math.pow(2, Math.min(connectionRetries - 1, 5));
  logger.info({ attempt: connectionRetries, delay }, 'Scheduling RabbitMQ reconnect');

  setTimeout(() => {
    connectRabbitMQ().catch(() => {
      // Error already logged
    });
  }, delay);
}

/**
 * Closes the RabbitMQ connection gracefully.
 */
export async function closeRabbitMQ(): Promise<void> {
  if (connection) {
    await connection.close();
    connection = null;
    publishChannel = null;
    consumeChannel = null;
    logger.info('RabbitMQ connection closed');
  }
}

/**
 * Checks if RabbitMQ is connected.
 */
export function isRabbitMQConnected(): boolean {
  return connection !== null && publishChannel !== null;
}

// =============================================================================
// Message Publishing
// =============================================================================

/**
 * Message envelope for all published messages.
 */
export interface MessageEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  timestamp: string;
  data: T;
  metadata?: {
    retryCount?: number;
    idempotencyKey?: string;
    correlationId?: string;
  };
}

/**
 * Publishes a message to an exchange.
 * Returns true if published successfully, false otherwise.
 *
 * @param exchange - Exchange name
 * @param routingKey - Routing key for message routing
 * @param data - Message payload
 * @param options - Additional publish options
 * @returns Promise resolving to success status
 */
export async function publishMessage<T>(
  exchange: string,
  routingKey: string,
  data: T,
  options: {
    idempotencyKey?: string;
    correlationId?: string;
  } = {}
): Promise<boolean> {
  if (!publishChannel) {
    logger.error('RabbitMQ not connected, cannot publish message');
    mqMessagesPublished.inc({ queue: exchange, event_type: routingKey, status: 'failure' });
    return false;
  }

  const envelope: MessageEnvelope<T> = {
    eventId: uuid(),
    eventType: routingKey,
    timestamp: new Date().toISOString(),
    data,
    metadata: {
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
    },
  };

  try {
    const success = publishChannel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        messageId: envelope.eventId,
        contentType: 'application/json',
        correlationId: options.correlationId,
      }
    );

    if (success) {
      mqMessagesPublished.inc({ queue: exchange, event_type: routingKey, status: 'success' });
      logging.queue('publish', exchange, routingKey, true);
    } else {
      mqMessagesPublished.inc({ queue: exchange, event_type: routingKey, status: 'failure' });
      logging.queue('publish', exchange, routingKey, false);
    }

    return success;
  } catch (error) {
    mqMessagesPublished.inc({ queue: exchange, event_type: routingKey, status: 'failure' });
    logging.queue('publish', exchange, routingKey, false, error as Error);
    return false;
  }
}

/**
 * Convenience method to publish an event to the events exchange.
 */
export async function publishEvent<T>(
  eventType: string,
  data: T,
  options: { idempotencyKey?: string; correlationId?: string } = {}
): Promise<boolean> {
  return publishMessage(QueueConfig.exchanges.events, eventType, data, options);
}

// =============================================================================
// Message Consumption
// =============================================================================

/**
 * Message handler function type.
 */
export type MessageHandler<T = unknown> = (
  message: MessageEnvelope<T>,
  rawMessage: ConsumeMessage
) => Promise<void>;

/**
 * Consumer options for message processing.
 */
export interface ConsumerOptions {
  prefetch?: number;
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * Starts consuming messages from a queue.
 *
 * @param queue - Queue name to consume from
 * @param handler - Message handler function
 * @param options - Consumer configuration options
 */
export async function consumeMessages<T>(
  queue: string,
  handler: MessageHandler<T>,
  options: ConsumerOptions = {}
): Promise<void> {
  if (!consumeChannel) {
    throw new Error('RabbitMQ not connected');
  }

  const { prefetch = 10, maxRetries = 3, retryDelay = 1000 } = options;
  const channel = consumeChannel;

  await channel.prefetch(prefetch);

  await channel.consume(queue, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const startTime = process.hrtime.bigint();

    try {
      const envelope = JSON.parse(msg.content.toString()) as MessageEnvelope<T>;

      logger.debug({ queue, eventType: envelope.eventType, eventId: envelope.eventId }, 'Processing message');

      await handler(envelope, msg);

      // Acknowledge successful processing
      channel.ack(msg);

      const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
      mqMessagesConsumed.inc({ queue, event_type: envelope.eventType, status: 'success' });
      mqProcessingDuration.observe({ queue, event_type: envelope.eventType }, duration);
      logging.queue('consume', queue, envelope.eventType, true);
    } catch (error) {
      const envelope = JSON.parse(msg.content.toString()) as MessageEnvelope<T>;
      const retryCount = (envelope.metadata?.retryCount || 0) + 1;

      logger.error(
        { queue, eventType: envelope.eventType, eventId: envelope.eventId, error: (error as Error).message },
        'Failed to process message'
      );

      if (retryCount <= maxRetries && publishChannel) {
        // Requeue with incremented retry count
        envelope.metadata = { ...envelope.metadata, retryCount };

        setTimeout(async () => {
          try {
            publishChannel.sendToQueue(
              queue,
              Buffer.from(JSON.stringify(envelope)),
              {
                persistent: true,
                messageId: envelope.eventId,
                contentType: 'application/json',
              }
            );
            channel.ack(msg);
            mqMessagesConsumed.inc({ queue, event_type: envelope.eventType, status: 'requeued' });
          } catch (requeueError) {
            // Failed to requeue, send to DLQ
            channel.nack(msg, false, false);
            mqMessagesConsumed.inc({ queue, event_type: envelope.eventType, status: 'failure' });
          }
        }, retryDelay * Math.pow(2, retryCount - 1));
      } else {
        // Max retries exceeded, send to DLQ
        channel.nack(msg, false, false);
        mqMessagesConsumed.inc({ queue, event_type: envelope.eventType, status: 'failure' });
        logging.queue('consume', queue, envelope.eventType, false, error as Error);
      }
    }
  });

  logger.info({ queue, prefetch }, 'Started consuming messages');
}

/**
 * Gets the approximate message count for a queue.
 */
export async function getQueueDepth(queue: string): Promise<number> {
  if (!publishChannel) return 0;

  try {
    const info = await publishChannel.checkQueue(queue);
    mqQueueDepth.set({ queue }, info.messageCount);
    return info.messageCount;
  } catch {
    return 0;
  }
}
