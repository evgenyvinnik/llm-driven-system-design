import amqp, { Connection, Channel, ConsumeMessage, Options } from 'amqplib';
import config from '../config/index.js';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';
import { withRetry } from './circuitBreaker.js';

const logger = createLogger('rabbitmq');

// Connection and channel state
let connection: Connection | null = null;
let channel: Channel | null = null;
let isConnecting = false;

interface ConnectionPromise {
  resolve: ((value: { connection: Connection; channel: Channel }) => void) | null;
  reject: ((reason: Error) => void) | null;
  promise: Promise<{ connection: Connection; channel: Channel }> | null;
}

const connectionPromise: ConnectionPromise = { resolve: null, reject: null, promise: null };

// Queue definitions
export const QUEUES = {
  MATCHING_REQUESTS: 'matching.requests',
  RIDE_EVENTS: 'ride.events',
  NOTIFICATIONS: 'notifications',
  ANALYTICS: 'analytics',
  DLQ: 'dead.letter.queue',
} as const;

// Exchange definitions
export const EXCHANGES = {
  RIDE_EVENTS: 'ride.events.fanout',
  DIRECT: 'uber.direct',
  DLX: 'dead.letter.exchange',
} as const;

// Message type
interface QueueMessage {
  eventId?: string;
  requestId?: string;
  eventType?: string;
  [key: string]: unknown;
}

// Consumer options interface
interface ConsumerOptions {
  noAck?: boolean;
  maxRetries?: number;
}

// Message handler type
type MessageHandler<T = unknown> = (content: T, msg: ConsumeMessage) => Promise<void>;

/**
 * Connect to RabbitMQ with retry logic
 */
export async function connectRabbitMQ(): Promise<{ connection: Connection; channel: Channel }> {
  if (connection && channel) {
    return { connection, channel };
  }

  if (isConnecting && connectionPromise.promise) {
    return connectionPromise.promise;
  }

  isConnecting = true;
  connectionPromise.promise = new Promise((resolve, reject) => {
    connectionPromise.resolve = resolve;
    connectionPromise.reject = reject;
  });

  try {
    const rabbitUrl = config.rabbitmq?.url || 'amqp://uber:uber@localhost:5672';
    logger.info({ url: rabbitUrl.replace(/:[^:@]+@/, ':***@') }, 'Connecting to RabbitMQ');

    connection = await withRetry(
      async () => {
        return await amqp.connect(rabbitUrl);
      },
      {
        maxRetries: 5,
        baseDelay: 1000,
        maxDelay: 10000,
        onRetry: (attempt, delay, error) => {
          logger.warn(
            { attempt, delay, error: error.message },
            'Retrying RabbitMQ connection'
          );
        },
      }
    );

    connection.on('error', (err: Error) => {
      logger.error({ error: err.message }, 'RabbitMQ connection error');
      metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 0);
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed');
      connection = null;
      channel = null;
      metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 0);
    });

    channel = await connection.createChannel();

    // Set prefetch for fair dispatch
    await channel.prefetch(10);

    // Set up exchanges
    await setupExchanges();

    // Set up queues
    await setupQueues();

    logger.info('RabbitMQ connected and queues initialized');
    metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 1);

    isConnecting = false;
    connectionPromise.resolve?.({ connection, channel });

    return { connection, channel };
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to connect to RabbitMQ');
    metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 0);
    isConnecting = false;
    connectionPromise.reject?.(err);
    throw error;
  }
}

/**
 * Set up exchanges
 */
async function setupExchanges(): Promise<void> {
  if (!channel) return;

  // Dead letter exchange
  await channel.assertExchange(EXCHANGES.DLX, 'direct', { durable: true });

  // Fanout exchange for ride events
  await channel.assertExchange(EXCHANGES.RIDE_EVENTS, 'fanout', { durable: true });

  // Direct exchange for point-to-point messaging
  await channel.assertExchange(EXCHANGES.DIRECT, 'direct', { durable: true });

  logger.debug('Exchanges set up');
}

/**
 * Set up queues with dead letter configuration
 */
async function setupQueues(): Promise<void> {
  if (!channel) return;

  // Dead letter queue
  await channel.assertQueue(QUEUES.DLQ, {
    durable: true,
  });
  await channel.bindQueue(QUEUES.DLQ, EXCHANGES.DLX, 'dead');

  // Matching requests queue (work queue)
  await channel.assertQueue(QUEUES.MATCHING_REQUESTS, {
    durable: true,
    deadLetterExchange: EXCHANGES.DLX,
    deadLetterRoutingKey: 'dead',
    messageTtl: 300000, // 5 minute TTL
  });
  await channel.bindQueue(QUEUES.MATCHING_REQUESTS, EXCHANGES.DIRECT, 'matching');

  // Notifications queue
  await channel.assertQueue(QUEUES.NOTIFICATIONS, {
    durable: true,
    deadLetterExchange: EXCHANGES.DLX,
    deadLetterRoutingKey: 'dead',
  });
  await channel.bindQueue(QUEUES.NOTIFICATIONS, EXCHANGES.RIDE_EVENTS, '');

  // Analytics queue
  await channel.assertQueue(QUEUES.ANALYTICS, {
    durable: true,
    // Analytics can tolerate message loss, no DLQ
  });
  await channel.bindQueue(QUEUES.ANALYTICS, EXCHANGES.RIDE_EVENTS, '');

  logger.debug('Queues set up');
}

/**
 * Publish message to a queue
 * @param queue - Queue name
 * @param message - Message payload
 * @param options - Publish options
 */
export async function publishToQueue(
  queue: string,
  message: QueueMessage,
  options: Options.Publish = {}
): Promise<boolean> {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const messageBuffer = Buffer.from(JSON.stringify(message));
    const publishOptions: Options.Publish = {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
      messageId: message.eventId || message.requestId || crypto.randomUUID(),
      ...options,
    };

    const result = channel!.sendToQueue(queue, messageBuffer, publishOptions);

    if (result) {
      metrics.queueMessagesPublished.inc({
        queue,
        event_type: message.eventType || 'unknown',
      });
      logger.debug({ queue, messageId: publishOptions.messageId }, 'Message published to queue');
    } else {
      logger.warn({ queue }, 'Queue write buffer full');
    }

    return result;
  } catch (error) {
    const err = error as Error;
    logger.error({ queue, error: err.message }, 'Failed to publish message');
    throw error;
  }
}

/**
 * Publish message to an exchange
 * @param exchange - Exchange name
 * @param routingKey - Routing key
 * @param message - Message payload
 * @param options - Publish options
 */
export async function publishToExchange(
  exchange: string,
  routingKey: string,
  message: QueueMessage,
  options: Options.Publish = {}
): Promise<boolean> {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const messageBuffer = Buffer.from(JSON.stringify(message));
    const publishOptions: Options.Publish = {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
      messageId: message.eventId || crypto.randomUUID(),
      ...options,
    };

    const result = channel!.publish(exchange, routingKey, messageBuffer, publishOptions);

    if (result) {
      metrics.queueMessagesPublished.inc({
        queue: exchange,
        event_type: message.eventType || 'unknown',
      });
      logger.debug({ exchange, routingKey, messageId: publishOptions.messageId }, 'Message published to exchange');
    }

    return result;
  } catch (error) {
    const err = error as Error;
    logger.error({ exchange, routingKey, error: err.message }, 'Failed to publish message to exchange');
    throw error;
  }
}

/**
 * Consume messages from a queue
 * @param queue - Queue name
 * @param handler - Message handler function
 * @param options - Consumer options
 */
export async function consumeQueue<T = unknown>(
  queue: string,
  handler: MessageHandler<T>,
  options: ConsumerOptions = {}
): Promise<void> {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const { noAck = false, maxRetries = 3 } = options;

    await channel!.consume(
      queue,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        const startTime = Date.now();
        const headers = msg.properties.headers as { 'x-retry-count'?: number; 'x-last-error'?: string } | undefined;
        const retryCount = headers?.['x-retry-count'] || 0;

        try {
          const content = JSON.parse(msg.content.toString()) as T;
          logger.debug({ queue, messageId: msg.properties.messageId }, 'Processing message');

          await handler(content, msg);

          if (!noAck) {
            channel!.ack(msg);
          }

          const duration = (Date.now() - startTime) / 1000;
          metrics.queueMessagesConsumed.inc({ queue, status: 'success' });
          metrics.queueProcessingDuration.observe({ queue }, duration);
        } catch (error) {
          const err = error as Error;
          logger.error(
            { queue, messageId: msg.properties.messageId, error: err.message, retryCount },
            'Error processing message'
          );

          if (!noAck) {
            if (retryCount < maxRetries) {
              // Requeue with incremented retry count
              const newHeaders = {
                ...headers,
                'x-retry-count': retryCount + 1,
                'x-last-error': err.message,
              };

              // Delay before retry using a delayed message
              setTimeout(() => {
                channel!.publish('', queue, msg.content, {
                  ...msg.properties,
                  headers: newHeaders,
                });
                channel!.ack(msg);
              }, Math.pow(2, retryCount) * 1000); // Exponential backoff
            } else {
              // Max retries reached, send to DLQ
              channel!.reject(msg, false);
              metrics.queueMessagesConsumed.inc({ queue, status: 'failed_to_dlq' });
            }
          }

          metrics.queueMessagesConsumed.inc({ queue, status: 'error' });
        }
      },
      { noAck }
    );

    logger.info({ queue }, 'Started consuming queue');
  } catch (error) {
    const err = error as Error;
    logger.error({ queue, error: err.message }, 'Failed to start consuming queue');
    throw error;
  }
}

/**
 * Get queue depth for monitoring
 * @param queue - Queue name
 * @returns Number of messages in queue
 */
export async function getQueueDepth(queue: string): Promise<number> {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const queueInfo = await channel!.checkQueue(queue);
    const depth = queueInfo.messageCount;

    metrics.queueDepthGauge.set({ queue }, depth);

    return depth;
  } catch (error) {
    const err = error as Error;
    logger.error({ queue, error: err.message }, 'Failed to get queue depth');
    return -1;
  }
}

/**
 * Check if RabbitMQ is healthy
 * @returns boolean indicating health status
 */
export async function isHealthy(): Promise<boolean> {
  try {
    if (!channel) {
      return false;
    }

    // Try to check a queue as a health check
    await channel.checkQueue(QUEUES.MATCHING_REQUESTS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gracefully close RabbitMQ connection
 */
export async function closeRabbitMQ(): Promise<void> {
  try {
    if (channel) {
      await channel.close();
    }
    if (connection) {
      await connection.close();
    }
    logger.info('RabbitMQ connection closed');
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Error closing RabbitMQ connection');
  }
}

export default {
  connectRabbitMQ,
  publishToQueue,
  publishToExchange,
  consumeQueue,
  getQueueDepth,
  isHealthy,
  closeRabbitMQ,
  QUEUES,
  EXCHANGES,
};
