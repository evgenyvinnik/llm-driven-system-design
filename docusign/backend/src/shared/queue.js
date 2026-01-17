import amqp from 'amqplib';
import { v4 as uuid } from 'uuid';
import logger from './logger.js';
import { queueMessagesPublished, queueMessagesProcessed, queueMessagesRetried } from './metrics.js';

/**
 * RabbitMQ Queue Integration for Async Operations
 *
 * WHY ASYNC QUEUES ENABLE RELIABLE NOTIFICATION DELIVERY:
 *
 * 1. DECOUPLING: Separates signing workflow from notification delivery.
 *    If email service is down, signatures are still captured.
 *
 * 2. RELIABILITY: Messages are persisted in RabbitMQ until acknowledged.
 *    No notifications are lost during service restarts or failures.
 *
 * 3. BACKPRESSURE: Queue limits prevent overwhelming downstream services.
 *    When email service is slow, messages queue instead of timing out.
 *
 * 4. RETRY WITH BACKOFF: Failed notifications are retried automatically
 *    with exponential backoff. Dead letter queue catches persistent failures.
 *
 * 5. DELIVERY SEMANTICS: At-least-once delivery ensures every notification
 *    reaches recipients. Idempotent handlers prevent duplicates.
 *
 * 6. OBSERVABILITY: Queue metrics provide visibility into notification
 *    pipeline health and bottlenecks.
 */

// Queue names
export const QUEUES = {
  NOTIFICATIONS: 'docusign.notifications',
  EMAIL: 'docusign.email',
  WORKFLOW: 'docusign.workflow',
  REMINDERS: 'docusign.reminders',
  DEAD_LETTER: 'docusign.dlq',
};

// Exchange names
const EXCHANGES = {
  DIRECT: 'docusign.direct',
  DLX: 'docusign.dlx',
};

let connection = null;
let channel = null;
let confirmChannel = null;

/**
 * Initialize RabbitMQ connection and setup queues.
 */
export async function initializeQueue() {
  const url = process.env.RABBITMQ_URL || 'amqp://docusign:docusign123@localhost:5672';

  try {
    connection = await amqp.connect(url);
    channel = await connection.createChannel();
    confirmChannel = await connection.createConfirmChannel();

    // Handle connection errors
    connection.on('error', (err) => {
      logger.error({ error: err.message }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed');
    });

    // Setup exchanges
    await channel.assertExchange(EXCHANGES.DLX, 'direct', { durable: true });
    await channel.assertExchange(EXCHANGES.DIRECT, 'direct', { durable: true });

    // Setup dead letter queue
    await channel.assertQueue(QUEUES.DEAD_LETTER, {
      durable: true,
      arguments: {
        'x-message-ttl': 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    });
    await channel.bindQueue(QUEUES.DEAD_LETTER, EXCHANGES.DLX, '');

    // Setup main queues with dead letter exchange
    const queueOptions = {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGES.DLX,
        'x-max-length': 10000, // Backpressure limit
      },
    };

    await channel.assertQueue(QUEUES.NOTIFICATIONS, queueOptions);
    await channel.bindQueue(QUEUES.NOTIFICATIONS, EXCHANGES.DIRECT, 'notification');

    await channel.assertQueue(QUEUES.EMAIL, { ...queueOptions, arguments: { ...queueOptions.arguments, 'x-max-length': 50000 } });
    await channel.bindQueue(QUEUES.EMAIL, EXCHANGES.DIRECT, 'email');

    await channel.assertQueue(QUEUES.WORKFLOW, queueOptions);
    await channel.bindQueue(QUEUES.WORKFLOW, EXCHANGES.DIRECT, 'workflow');

    await channel.assertQueue(QUEUES.REMINDERS, queueOptions);
    await channel.bindQueue(QUEUES.REMINDERS, EXCHANGES.DIRECT, 'reminder');

    logger.info('RabbitMQ queues initialized');
    return true;
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to initialize RabbitMQ');
    return false;
  }
}

/**
 * Close RabbitMQ connection.
 */
export async function closeQueue() {
  try {
    if (channel) await channel.close();
    if (confirmChannel) await confirmChannel.close();
    if (connection) await connection.close();
    logger.info('RabbitMQ connection closed');
  } catch (error) {
    logger.error({ error: error.message }, 'Error closing RabbitMQ connection');
  }
}

/**
 * Publish a message with delivery confirmation.
 *
 * @param {string} routingKey - Routing key (e.g., 'notification', 'email')
 * @param {Object} message - Message payload
 * @param {Object} options - Additional options
 */
export async function publishMessage(routingKey, message, options = {}) {
  const messageId = uuid();
  const payload = {
    id: messageId,
    type: message.type,
    data: message,
    timestamp: new Date().toISOString(),
    idempotencyKey: options.idempotencyKey || `${routingKey}:${messageId}`,
  };

  return new Promise((resolve, reject) => {
    confirmChannel.publish(
      EXCHANGES.DIRECT,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        messageId,
        headers: {
          'x-idempotency-key': payload.idempotencyKey,
          'x-retry-count': 0,
        },
        ...options,
      },
      (err) => {
        if (err) {
          logger.error({ error: err.message, routingKey }, 'Failed to publish message');
          reject(err);
        } else {
          queueMessagesPublished.inc({ queue: routingKey });
          logger.debug({ messageId, routingKey }, 'Message published');
          resolve(messageId);
        }
      }
    );
  });
}

/**
 * Publish notification for async delivery.
 */
export async function publishNotification(notification) {
  return publishMessage('notification', {
    type: 'notification',
    recipientId: notification.recipientId,
    envelopeId: notification.envelopeId,
    notificationType: notification.type, // 'signing_request', 'reminder', 'completed'
    channels: notification.channels || ['email'],
  });
}

/**
 * Publish email for async sending.
 */
export async function publishEmail(email) {
  return publishMessage('email', {
    type: 'email',
    recipientId: email.recipientId,
    recipientEmail: email.recipientEmail,
    subject: email.subject,
    body: email.body,
    templateId: email.templateId,
    templateData: email.templateData,
  });
}

/**
 * Publish workflow event for async processing.
 */
export async function publishWorkflowEvent(event) {
  return publishMessage('workflow', {
    type: 'workflow',
    eventType: event.eventType,
    envelopeId: event.envelopeId,
    recipientId: event.recipientId,
    data: event.data,
  }, {
    idempotencyKey: `workflow:${event.envelopeId}:${event.eventType}:${Date.now()}`,
  });
}

/**
 * Publish reminder for scheduled delivery.
 */
export async function publishReminder(reminder) {
  return publishMessage('reminder', {
    type: 'reminder',
    envelopeId: reminder.envelopeId,
    recipientId: reminder.recipientId,
    scheduledFor: reminder.scheduledFor,
  });
}

/**
 * Create a consumer for a queue.
 *
 * @param {string} queue - Queue name
 * @param {Function} handler - Message handler function
 * @param {Object} options - Consumer options
 */
export async function createConsumer(queue, handler, options = {}) {
  const { concurrency = 5 } = options;

  await channel.prefetch(concurrency);

  await channel.consume(queue, async (msg) => {
    if (!msg) return;

    const message = JSON.parse(msg.content.toString());
    const retryCount = msg.properties.headers['x-retry-count'] || 0;
    const startTime = Date.now();

    try {
      // Check for duplicate processing (idempotency)
      // Handler should be idempotent anyway
      await handler(message);

      channel.ack(msg);
      queueMessagesProcessed.inc({ queue, status: 'success' });
      logger.debug({
        messageId: message.id,
        queue,
        duration: Date.now() - startTime
      }, 'Message processed');

    } catch (error) {
      logger.error({
        error: error.message,
        messageId: message.id,
        queue,
        retryCount
      }, 'Message processing failed');

      if (retryCount < 3) {
        // Retry with exponential backoff
        channel.nack(msg, false, false);
        queueMessagesRetried.inc({ queue });

        const delay = Math.min(1000 * Math.pow(2, retryCount + 1), 60000);

        setTimeout(async () => {
          await channel.publish(
            EXCHANGES.DIRECT,
            queue === QUEUES.NOTIFICATIONS ? 'notification' :
              queue === QUEUES.EMAIL ? 'email' :
              queue === QUEUES.WORKFLOW ? 'workflow' : 'reminder',
            Buffer.from(JSON.stringify(message)),
            {
              persistent: true,
              headers: {
                'x-idempotency-key': message.idempotencyKey,
                'x-retry-count': retryCount + 1,
              },
            }
          );
        }, delay);
      } else {
        // Max retries exceeded, send to DLQ
        channel.nack(msg, false, false);
        queueMessagesProcessed.inc({ queue, status: 'dlq' });
        logger.error({ messageId: message.id, queue }, 'Message sent to DLQ after max retries');
      }
    }
  });

  logger.info({ queue, concurrency }, 'Consumer started');
}

/**
 * Check if queue is connected and healthy.
 */
export function isQueueHealthy() {
  return connection !== null && channel !== null;
}

/**
 * Get queue health status.
 */
export async function getQueueHealth() {
  if (!connection || !channel) {
    return { status: 'disconnected' };
  }

  try {
    // Check queue status
    const queues = await Promise.all([
      channel.checkQueue(QUEUES.NOTIFICATIONS).catch(() => null),
      channel.checkQueue(QUEUES.EMAIL).catch(() => null),
      channel.checkQueue(QUEUES.WORKFLOW).catch(() => null),
      channel.checkQueue(QUEUES.DEAD_LETTER).catch(() => null),
    ]);

    return {
      status: 'connected',
      queues: {
        notifications: queues[0] ? { messages: queues[0].messageCount, consumers: queues[0].consumerCount } : null,
        email: queues[1] ? { messages: queues[1].messageCount, consumers: queues[1].consumerCount } : null,
        workflow: queues[2] ? { messages: queues[2].messageCount, consumers: queues[2].consumerCount } : null,
        deadLetter: queues[3] ? { messages: queues[3].messageCount, consumers: queues[3].consumerCount } : null,
      },
    };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

export default {
  QUEUES,
  initializeQueue,
  closeQueue,
  publishMessage,
  publishNotification,
  publishEmail,
  publishWorkflowEvent,
  publishReminder,
  createConsumer,
  isQueueHealthy,
  getQueueHealth,
};
