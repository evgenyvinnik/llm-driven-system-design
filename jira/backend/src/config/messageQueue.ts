import amqplib from 'amqplib';
import { config } from './index.js';
import { logger } from './logger.js';
import { messagesPublishedCounter, messagesConsumedCounter } from './metrics.js';
import { v4 as uuid } from 'uuid';

/**
 * Queue names used throughout the application.
 */
export const QUEUES = {
  /** Fanout exchange for all issue events */
  ISSUE_EVENTS: 'jira.issue.events',
  /** Direct queue for search index updates */
  SEARCH_INDEX: 'jira.search.index',
  /** Direct queue for notifications (email/in-app) */
  NOTIFICATIONS: 'jira.notifications',
  /** Direct queue for webhook delivery */
  WEBHOOKS: 'jira.webhooks',
  /** Direct queue for bulk operations */
  BULK_OPERATIONS: 'jira.bulk.operations',
} as const;

/**
 * Exchange names for message routing.
 */
export const EXCHANGES = {
  /** Fanout exchange for issue events - all consumers receive all messages */
  ISSUE_EVENTS: 'jira.issue.events.fanout',
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connection: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channel: any = null;
let isConnecting = false;
let connectionRetries = 0;
const MAX_RETRIES = 5;

/**
 * Initializes connection to RabbitMQ.
 * Sets up exchanges and queues with appropriate durability and dead-letter configuration.
 *
 * @returns Promise resolving to the channel, or null if connection fails
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function initializeMessageQueue(): Promise<any | null> {
  if (channel) return channel;
  if (isConnecting) return null;

  isConnecting = true;

  try {
    const url = config.rabbitmq?.url || 'amqp://jira:jira_dev@localhost:5672';
    connection = await amqplib.connect(url);
    channel = await connection.createChannel();

    // Set prefetch for backpressure control
    await channel.prefetch(10);

    // Create exchanges
    await channel.assertExchange(EXCHANGES.ISSUE_EVENTS, 'fanout', { durable: true });

    // Create queues with dead-letter configuration
    for (const queueName of Object.values(QUEUES)) {
      await channel.assertQueue(queueName, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': `${queueName}.dlq`,
        },
      });

      // Create dead-letter queue
      await channel.assertQueue(`${queueName}.dlq`, { durable: true });
    }

    // Bind issue events queue to fanout exchange
    await channel.bindQueue(QUEUES.ISSUE_EVENTS, EXCHANGES.ISSUE_EVENTS, '');
    await channel.bindQueue(QUEUES.SEARCH_INDEX, EXCHANGES.ISSUE_EVENTS, '');
    await channel.bindQueue(QUEUES.NOTIFICATIONS, EXCHANGES.ISSUE_EVENTS, '');
    await channel.bindQueue(QUEUES.WEBHOOKS, EXCHANGES.ISSUE_EVENTS, '');

    connection.on('error', (err: Error) => {
      logger.error({ err }, 'RabbitMQ connection error');
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed, attempting reconnect...');
      channel = null;
      connection = null;
      if (connectionRetries < MAX_RETRIES) {
        connectionRetries++;
        setTimeout(() => initializeMessageQueue(), 5000);
      }
    });

    logger.info('Connected to RabbitMQ');
    connectionRetries = 0;
    isConnecting = false;
    return channel;
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to RabbitMQ');
    isConnecting = false;

    if (connectionRetries < MAX_RETRIES) {
      connectionRetries++;
      logger.info({ retries: connectionRetries }, 'Retrying RabbitMQ connection...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return initializeMessageQueue();
    }

    return null;
  }
}

/**
 * Message payload for issue events.
 */
export interface IssueEventMessage {
  /** Unique event ID for deduplication */
  event_id: string;
  /** Type of event */
  event_type: 'created' | 'updated' | 'deleted' | 'transitioned' | 'commented';
  /** Issue ID */
  issue_id: number;
  /** Issue key (e.g., "PROJ-123") */
  issue_key: string;
  /** Project ID */
  project_id: string;
  /** Project key */
  project_key: string;
  /** Fields that changed (for updates) */
  changes?: Record<string, { old: unknown; new: unknown }>;
  /** User who triggered the event */
  actor_id: string;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Publishes an issue event to the fanout exchange.
 * All subscribed queues (search index, notifications, webhooks) will receive the message.
 *
 * @param event - Issue event data to publish
 */
export async function publishIssueEvent(event: Omit<IssueEventMessage, 'event_id' | 'timestamp'>): Promise<void> {
  if (!channel) {
    logger.warn('RabbitMQ channel not available, skipping event publish');
    return;
  }

  const message: IssueEventMessage = {
    ...event,
    event_id: uuid(),
    timestamp: new Date().toISOString(),
  };

  try {
    channel.publish(
      EXCHANGES.ISSUE_EVENTS,
      '',
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: message.event_id,
      }
    );

    messagesPublishedCounter.inc({ queue_name: QUEUES.ISSUE_EVENTS });
    logger.debug({ event_id: message.event_id, event_type: event.event_type }, 'Published issue event');
  } catch (error) {
    logger.error({ err: error, event }, 'Failed to publish issue event');
  }
}

/**
 * Publishes a message to a specific queue.
 *
 * @param queueName - Name of the queue to publish to
 * @param message - Message payload
 * @param options - Additional publish options
 */
export async function publishToQueue(
  queueName: string,
  message: Record<string, unknown>,
  options: { messageId?: string; priority?: number } = {}
): Promise<void> {
  if (!channel) {
    logger.warn({ queue: queueName }, 'RabbitMQ channel not available, skipping publish');
    return;
  }

  const messageId = options.messageId || uuid();

  try {
    channel.sendToQueue(
      queueName,
      Buffer.from(JSON.stringify({ ...message, event_id: messageId })),
      {
        persistent: true,
        contentType: 'application/json',
        messageId,
        priority: options.priority,
      }
    );

    messagesPublishedCounter.inc({ queue_name: queueName });
    logger.debug({ queue: queueName, messageId }, 'Published message to queue');
  } catch (error) {
    logger.error({ err: error, queue: queueName }, 'Failed to publish to queue');
  }
}

/**
 * Message handler function type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageHandler = (message: Record<string, unknown>, msg: any) => Promise<void>;

/**
 * Starts consuming messages from a queue.
 *
 * @param queueName - Queue to consume from
 * @param handler - Handler function for processing messages
 * @param options - Consumer options
 */
export async function consumeQueue(
  queueName: string,
  handler: MessageHandler,
  options: { maxRetries?: number } = {}
): Promise<void> {
  if (!channel) {
    logger.warn({ queue: queueName }, 'RabbitMQ channel not available, cannot start consumer');
    return;
  }

  const maxRetries = options.maxRetries ?? 3;
  const ch = channel; // Capture for closure

  await ch.consume(
    queueName,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (msg: any) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString());
        await handler(content, msg);
        ch.ack(msg);
        messagesConsumedCounter.inc({ queue_name: queueName, status: 'success' });
      } catch (error) {
        const headers = msg.properties.headers || {};
        const retryCount = ((headers['x-retry-count'] as number) || 0) + 1;
        logger.error({ err: error, queue: queueName, retryCount }, 'Error processing message');

        if (retryCount >= maxRetries) {
          // Send to dead-letter queue
          ch.reject(msg, false);
          messagesConsumedCounter.inc({ queue_name: queueName, status: 'error' });
        } else {
          // Requeue with incremented retry count
          setTimeout(() => {
            ch.publish(
              '',
              queueName,
              msg.content,
              {
                ...msg.properties,
                headers: { ...headers, 'x-retry-count': retryCount },
              }
            );
            ch.ack(msg);
          }, Math.pow(2, retryCount - 1) * 1000); // Exponential backoff
        }
      }
    },
    { noAck: false }
  );

  logger.info({ queue: queueName }, 'Started consuming queue');
}

/**
 * Closes the RabbitMQ connection gracefully.
 */
export async function closeMessageQueue(): Promise<void> {
  if (channel) {
    await channel.close();
    channel = null;
  }
  if (connection) {
    await connection.close();
    connection = null;
  }
  logger.info('Closed RabbitMQ connection');
}

/**
 * Gets the current channel for direct access.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getChannel(): any | null {
  return channel;
}

export default {
  initializeMessageQueue,
  publishIssueEvent,
  publishToQueue,
  consumeQueue,
  closeMessageQueue,
  getChannel,
  QUEUES,
  EXCHANGES,
};
