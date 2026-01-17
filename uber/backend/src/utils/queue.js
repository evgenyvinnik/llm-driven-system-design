import amqp from 'amqplib';
import config from '../config/index.js';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';
import { withRetry } from './circuitBreaker.js';

const logger = createLogger('rabbitmq');

// Connection and channel state
let connection = null;
let channel = null;
let isConnecting = false;
const connectionPromise = { resolve: null, promise: null };

// Queue definitions
export const QUEUES = {
  MATCHING_REQUESTS: 'matching.requests',
  RIDE_EVENTS: 'ride.events',
  NOTIFICATIONS: 'notifications',
  ANALYTICS: 'analytics',
  DLQ: 'dead.letter.queue',
};

// Exchange definitions
export const EXCHANGES = {
  RIDE_EVENTS: 'ride.events.fanout',
  DIRECT: 'uber.direct',
  DLX: 'dead.letter.exchange',
};

/**
 * Connect to RabbitMQ with retry logic
 */
export async function connectRabbitMQ() {
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

    connection.on('error', (err) => {
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
    connectionPromise.resolve({ connection, channel });

    return { connection, channel };
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to connect to RabbitMQ');
    metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 0);
    isConnecting = false;
    connectionPromise.reject(error);
    throw error;
  }
}

/**
 * Set up exchanges
 */
async function setupExchanges() {
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
async function setupQueues() {
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
 * @param {string} queue - Queue name
 * @param {Object} message - Message payload
 * @param {Object} options - Publish options
 */
export async function publishToQueue(queue, message, options = {}) {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const messageBuffer = Buffer.from(JSON.stringify(message));
    const publishOptions = {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
      messageId: message.eventId || message.requestId || crypto.randomUUID(),
      ...options,
    };

    const result = channel.sendToQueue(queue, messageBuffer, publishOptions);

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
    logger.error({ queue, error: error.message }, 'Failed to publish message');
    throw error;
  }
}

/**
 * Publish message to an exchange
 * @param {string} exchange - Exchange name
 * @param {string} routingKey - Routing key
 * @param {Object} message - Message payload
 * @param {Object} options - Publish options
 */
export async function publishToExchange(exchange, routingKey, message, options = {}) {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const messageBuffer = Buffer.from(JSON.stringify(message));
    const publishOptions = {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
      messageId: message.eventId || crypto.randomUUID(),
      ...options,
    };

    const result = channel.publish(exchange, routingKey, messageBuffer, publishOptions);

    if (result) {
      metrics.queueMessagesPublished.inc({
        queue: exchange,
        event_type: message.eventType || 'unknown',
      });
      logger.debug({ exchange, routingKey, messageId: publishOptions.messageId }, 'Message published to exchange');
    }

    return result;
  } catch (error) {
    logger.error({ exchange, routingKey, error: error.message }, 'Failed to publish message to exchange');
    throw error;
  }
}

/**
 * Consume messages from a queue
 * @param {string} queue - Queue name
 * @param {Function} handler - Message handler function
 * @param {Object} options - Consumer options
 */
export async function consumeQueue(queue, handler, options = {}) {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const { noAck = false, maxRetries = 3 } = options;

    await channel.consume(
      queue,
      async (msg) => {
        if (!msg) return;

        const startTime = Date.now();
        const retryCount = (msg.properties.headers?.['x-retry-count'] || 0);

        try {
          const content = JSON.parse(msg.content.toString());
          logger.debug({ queue, messageId: msg.properties.messageId }, 'Processing message');

          await handler(content, msg);

          if (!noAck) {
            channel.ack(msg);
          }

          const duration = (Date.now() - startTime) / 1000;
          metrics.queueMessagesConsumed.inc({ queue, status: 'success' });
          metrics.queueProcessingDuration.observe({ queue }, duration);
        } catch (error) {
          logger.error(
            { queue, messageId: msg.properties.messageId, error: error.message, retryCount },
            'Error processing message'
          );

          if (!noAck) {
            if (retryCount < maxRetries) {
              // Requeue with incremented retry count
              const newHeaders = {
                ...msg.properties.headers,
                'x-retry-count': retryCount + 1,
                'x-last-error': error.message,
              };

              // Delay before retry using a delayed message
              setTimeout(() => {
                channel.publish('', queue, msg.content, {
                  ...msg.properties,
                  headers: newHeaders,
                });
                channel.ack(msg);
              }, Math.pow(2, retryCount) * 1000); // Exponential backoff
            } else {
              // Max retries reached, send to DLQ
              channel.reject(msg, false);
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
    logger.error({ queue, error: error.message }, 'Failed to start consuming queue');
    throw error;
  }
}

/**
 * Get queue depth for monitoring
 * @param {string} queue - Queue name
 * @returns {Promise<number>} Number of messages in queue
 */
export async function getQueueDepth(queue) {
  try {
    if (!channel) {
      await connectRabbitMQ();
    }

    const queueInfo = await channel.checkQueue(queue);
    const depth = queueInfo.messageCount;

    metrics.queueDepthGauge.set({ queue }, depth);

    return depth;
  } catch (error) {
    logger.error({ queue, error: error.message }, 'Failed to get queue depth');
    return -1;
  }
}

/**
 * Check if RabbitMQ is healthy
 * @returns {Promise<boolean>}
 */
export async function isHealthy() {
  try {
    if (!channel) {
      return false;
    }

    // Try to check a queue as a health check
    await channel.checkQueue(QUEUES.MATCHING_REQUESTS);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Gracefully close RabbitMQ connection
 */
export async function closeRabbitMQ() {
  try {
    if (channel) {
      await channel.close();
    }
    if (connection) {
      await connection.close();
    }
    logger.info('RabbitMQ connection closed');
  } catch (error) {
    logger.error({ error: error.message }, 'Error closing RabbitMQ connection');
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
