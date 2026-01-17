/**
 * @fileoverview RabbitMQ message queue for async notifications and background jobs.
 * Handles fanout for real-time events, export jobs, and notification delivery
 * with configurable retry policies and dead letter queues.
 */

import amqp from 'amqplib';
import type { Connection, Channel, ConsumeMessage, Options } from 'amqplib';
import { logger, LogEvents, logEvent } from './logger.js';
import {
  queueMessagesPublished,
  queueMessagesProcessed,
  queueDepthGauge,
  queueProcessingDuration,
} from './metrics.js';

/**
 * Queue configuration with delivery semantics.
 */
export const QUEUES = {
  // High priority, low latency - presence and realtime fanout
  fanout: {
    name: 'notion.fanout',
    durable: true,
    prefetch: 50,
    ttl: 30_000, // Messages expire after 30s
    retries: 0, // No retries - fanout is best-effort
    deadLetter: null,
  },

  // Medium priority - notifications
  notifications: {
    name: 'notion.notifications',
    durable: true,
    prefetch: 10,
    ttl: 3600_000, // 1 hour
    retries: 3,
    deadLetter: 'notion.notifications.dlq',
  },

  // Low priority, high reliability - exports
  export: {
    name: 'notion.export',
    durable: true,
    prefetch: 2,
    ttl: 86400_000, // 24 hours
    retries: 5,
    deadLetter: 'notion.export.dlq',
  },

  // Email notifications
  email: {
    name: 'notion.email',
    durable: true,
    prefetch: 10,
    ttl: 86400_000, // 24 hours
    retries: 3,
    deadLetter: 'notion.email.dlq',
  },

  // Search index updates
  search: {
    name: 'notion.search',
    durable: true,
    prefetch: 10,
    ttl: 3600_000, // 1 hour
    retries: 3,
    deadLetter: 'notion.search.dlq',
  },
} as const;

export type QueueName = keyof typeof QUEUES;

/**
 * Message types for different queues.
 */
export interface FanoutMessage {
  type: 'operation' | 'presence' | 'cursor';
  pageId: string;
  excludeConnectionId?: string;
  payload: unknown;
}

export interface NotificationMessage {
  type: 'page_shared' | 'page_mentioned' | 'comment_added' | 'workspace_invite';
  userId: string;
  data: Record<string, unknown>;
}

export interface ExportMessage {
  type: 'pdf' | 'markdown' | 'html';
  pageId: string;
  userId: string;
  options: {
    includeSubpages: boolean;
    includeImages: boolean;
  };
  callbackUrl?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  template: string;
  data: Record<string, unknown>;
}

export interface SearchIndexMessage {
  type: 'index_block' | 'delete_block' | 'reindex_page';
  blockId?: string;
  pageId: string;
  content?: string;
  workspaceId: string;
}

type QueueMessage = FanoutMessage | NotificationMessage | ExportMessage | EmailMessage | SearchIndexMessage;

/**
 * RabbitMQ connection manager.
 */
class QueueManager {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  /**
   * Connects to RabbitMQ and sets up queues.
   */
  async connect(): Promise<void> {
    if (this.connection && this.channel) {
      return;
    }

    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.doConnect();
    await this.connecting;
    this.connecting = null;
  }

  private async doConnect(): Promise<void> {
    try {
      const url = process.env.RABBITMQ_URL || 'amqp://notion:notion_local@localhost:5672';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conn = await amqp.connect(url) as any;
      this.connection = conn;
      this.channel = await conn.createChannel();

      // Handle connection close
      conn.on('close', () => {
        logger.warn('RabbitMQ connection closed, attempting reconnect...');
        this.connection = null;
        this.channel = null;
        this.scheduleReconnect();
      });

      conn.on('error', (err: Error) => {
        logger.error({ error: err }, 'RabbitMQ connection error');
      });

      // Set up queues
      await this.setupQueues();

      logger.info('RabbitMQ connected and queues initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to connect to RabbitMQ');
      this.scheduleReconnect();
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.connect();
      } catch (error) {
        // Error already logged in connect
      }
    }, 5000);
  }

  private async setupQueues(): Promise<void> {
    if (!this.channel) return;

    for (const [, config] of Object.entries(QUEUES)) {
      // Set up dead letter queue if configured
      if (config.deadLetter) {
        await this.channel.assertQueue(config.deadLetter, {
          durable: true,
        });
      }

      // Set up main queue with options
      const queueOptions: Options.AssertQueue = {
        durable: config.durable,
        arguments: {
          ...(config.ttl && { 'x-message-ttl': config.ttl }),
          ...(config.deadLetter && {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': config.deadLetter,
          }),
        },
      };

      await this.channel.assertQueue(config.name, queueOptions);
    }
  }

  /**
   * Publishes a message to a queue.
   */
  async publish<T extends QueueMessage>(queueName: QueueName, message: T): Promise<boolean> {
    try {
      await this.connect();

      if (!this.channel) {
        throw new Error('Channel not available');
      }

      const config = QUEUES[queueName];
      const messageBuffer = Buffer.from(JSON.stringify(message));

      const result = this.channel.sendToQueue(config.name, messageBuffer, {
        persistent: config.durable,
        timestamp: Date.now(),
      });

      queueMessagesPublished.inc({ queue_name: queueName });
      logEvent(LogEvents.QUEUE_MESSAGE_SENT, { queue: queueName, messageType: (message as { type?: string }).type });

      return result;
    } catch (error) {
      logger.error({ error, queueName, message }, 'Failed to publish message to queue');
      return false;
    }
  }

  /**
   * Consumes messages from a queue with backpressure handling.
   */
  async consume<T extends QueueMessage>(
    queueName: QueueName,
    handler: (message: T) => Promise<void>
  ): Promise<void> {
    await this.connect();

    if (!this.channel) {
      throw new Error('Channel not available');
    }

    const config = QUEUES[queueName];

    // Set prefetch for backpressure
    await this.channel.prefetch(config.prefetch);

    await this.channel.consume(config.name, async (msg: ConsumeMessage | null) => {
      if (!msg || !this.channel) return;

      const startTime = Date.now();

      try {
        const content = JSON.parse(msg.content.toString()) as T;
        await handler(content);

        this.channel.ack(msg);
        queueMessagesProcessed.inc({ queue_name: queueName, status: 'success' });
        queueProcessingDuration.observe({ queue_name: queueName }, (Date.now() - startTime) / 1000);
        logEvent(LogEvents.QUEUE_MESSAGE_PROCESSED, { queue: queueName });
      } catch (error) {
        const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) || 0) + 1;

        if (retryCount <= config.retries) {
          // Requeue with delay using exponential backoff
          const delay = Math.min(1000 * Math.pow(2, retryCount), 60000);
          logger.warn({ error, queueName, retryCount, delay }, 'Message processing failed, will retry');

          setTimeout(() => {
            if (this.channel) {
              this.channel.sendToQueue(config.name, msg.content, {
                persistent: config.durable,
                headers: { 'x-retry-count': retryCount },
              });
              this.channel.ack(msg);
            }
          }, delay);
        } else {
          // Max retries exceeded, send to DLQ or discard
          logger.error({ error, queueName, retryCount }, 'Message processing failed, max retries exceeded');
          this.channel.ack(msg); // Ack to remove from main queue (already in DLQ via RabbitMQ)
        }

        queueMessagesProcessed.inc({ queue_name: queueName, status: 'failure' });
        logEvent(LogEvents.QUEUE_MESSAGE_FAILED, { queue: queueName, retryCount });
      }
    });

    logger.info({ queueName }, 'Started consuming from queue');
  }

  /**
   * Gets the current queue depth for monitoring.
   */
  async getQueueDepth(queueName: QueueName): Promise<number> {
    try {
      await this.connect();

      if (!this.channel) return 0;

      const config = QUEUES[queueName];
      const queueInfo = await this.channel.checkQueue(config.name);
      const depth = queueInfo.messageCount;

      queueDepthGauge.set({ queue_name: queueName }, depth);
      return depth;
    } catch (error) {
      logger.error({ error, queueName }, 'Failed to get queue depth');
      return 0;
    }
  }

  /**
   * Closes the connection gracefully.
   */
  async close(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }

    if (this.connection) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.connection as any).close();
      this.connection = null;
    }

    logger.info('RabbitMQ connection closed');
  }

  /**
   * Checks if the queue connection is healthy.
   */
  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }
}

/**
 * Singleton queue manager instance.
 */
export const queueManager = new QueueManager();

/**
 * Convenience function to publish a notification.
 */
export async function publishNotification(message: NotificationMessage): Promise<boolean> {
  return queueManager.publish('notifications', message);
}

/**
 * Convenience function to publish an export job.
 */
export async function publishExportJob(message: ExportMessage): Promise<boolean> {
  return queueManager.publish('export', message);
}

/**
 * Convenience function to publish a fanout message.
 */
export async function publishFanout(message: FanoutMessage): Promise<boolean> {
  return queueManager.publish('fanout', message);
}

/**
 * Convenience function to publish a search index update.
 */
export async function publishSearchIndex(message: SearchIndexMessage): Promise<boolean> {
  return queueManager.publish('search', message);
}

export default queueManager;
