import amqp from 'amqplib';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import { logger } from './logger.js';

/**
 * Queue names for RabbitMQ message routing.
 */
export const QUEUES = {
  /** Queue for booking-related notifications (confirmation, cancellation, reschedule) */
  BOOKING_NOTIFICATIONS: 'booking-notifications',
  /** Queue for scheduled reminder notifications */
  REMINDERS: 'reminders',
  /** Dead letter queue for failed messages */
  DLQ: 'notifications-dlq',
} as const;

/**
 * Notification types for the booking-notifications queue.
 */
export type NotificationType = 'booking_confirmed' | 'booking_cancelled' | 'booking_rescheduled';

/**
 * Payload structure for booking notification messages.
 */
export interface BookingNotificationPayload {
  type: NotificationType;
  bookingId: string;
  hostUserId: string;
  inviteeEmail: string;
  inviteeName: string;
  meetingTypeName: string;
  meetingTypeId: string;
  hostName: string;
  hostEmail: string;
  startTime: string;
  endTime: string;
  inviteeTimezone: string;
  notes?: string;
  cancellationReason?: string;
  timestamp: string;
}

/**
 * Payload structure for reminder messages.
 */
export interface ReminderPayload {
  bookingId: string;
  reminderTime: string;
  hoursUntil: number;
  inviteeEmail: string;
  inviteeName: string;
  startTime: string;
  inviteeTimezone: string;
}

/**
 * Handler function type for consuming notification messages.
 */
export type NotificationHandler = (payload: BookingNotificationPayload) => Promise<void>;

/**
 * Handler function type for consuming reminder messages.
 */
export type ReminderHandler = (payload: ReminderPayload) => Promise<void>;

/**
 * RabbitMQ connection and queue management service.
 * Handles connection lifecycle, queue setup, and message publishing/consuming.
 */
class QueueService {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private connectionUrl: string;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000;

  constructor() {
    const host = process.env.RABBITMQ_HOST || 'localhost';
    const port = process.env.RABBITMQ_PORT || '5672';
    const user = process.env.RABBITMQ_USER || 'guest';
    const password = process.env.RABBITMQ_PASSWORD || 'guest';
    this.connectionUrl = 'amqp://' + user + ':' + password + '@' + host + ':' + port;
  }

  /**
   * Establishes connection to RabbitMQ and sets up queues.
   * Includes automatic reconnection logic for resilience.
   */
  async connect(): Promise<void> {
    if (this.connection || this.isConnecting) {
      return;
    }

    this.isConnecting = true;

    try {
      logger.info('Connecting to RabbitMQ...');
      this.connection = await amqp.connect(this.connectionUrl);
      this.channel = await this.connection.createChannel();

      // Set up error handlers for connection recovery
      this.connection.on('error', (err: Error) => {
        logger.error({ error: err }, 'RabbitMQ connection error');
        this.handleDisconnection();
      });

      this.connection.on('close', () => {
        logger.warn('RabbitMQ connection closed');
        this.handleDisconnection();
      });

      // Set up queues with dead letter exchange
      await this.setupQueues();

      this.reconnectAttempts = 0;
      logger.info('RabbitMQ connected successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to connect to RabbitMQ');
      this.handleDisconnection();
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Sets up queues with dead letter exchange for failed message handling.
   */
  private async setupQueues(): Promise<void> {
    if (!this.channel) {
      throw new Error('Channel not initialized');
    }

    // Create dead letter exchange
    await this.channel.assertExchange('notifications-dlx', 'direct', { durable: true });

    // Create dead letter queue
    await this.channel.assertQueue(QUEUES.DLQ, {
      durable: true,
    });
    await this.channel.bindQueue(QUEUES.DLQ, 'notifications-dlx', 'notifications');

    // Create main notification queue with dead letter routing
    await this.channel.assertQueue(QUEUES.BOOKING_NOTIFICATIONS, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'notifications-dlx',
        'x-dead-letter-routing-key': 'notifications',
      },
    });

    // Create reminders queue with dead letter routing
    await this.channel.assertQueue(QUEUES.REMINDERS, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'notifications-dlx',
        'x-dead-letter-routing-key': 'notifications',
      },
    });

    // Set prefetch to 1 for fair distribution across workers
    await this.channel.prefetch(1);

    logger.info('RabbitMQ queues set up successfully');
  }

  /**
   * Handles disconnection by attempting to reconnect with exponential backoff.
   */
  private handleDisconnection(): void {
    this.connection = null;
    this.channel = null;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      logger.info(
        { attempt: this.reconnectAttempts, delay },
        'Scheduling RabbitMQ reconnection'
      );
      setTimeout(() => this.connect(), delay);
    } else {
      logger.error('Max reconnection attempts reached for RabbitMQ');
    }
  }

  /**
   * Publishes a booking notification to the queue.
   * @param type - Type of notification (confirmed, cancelled, rescheduled)
   * @param data - Notification payload data
   */
  async publishNotification(
    type: NotificationType,
    data: Omit<BookingNotificationPayload, 'type' | 'timestamp'>
  ): Promise<void> {
    await this.ensureConnected();

    const payload: BookingNotificationPayload = {
      type,
      ...data,
      timestamp: new Date().toISOString(),
    };

    const message = Buffer.from(JSON.stringify(payload));

    try {
      this.channel!.sendToQueue(QUEUES.BOOKING_NOTIFICATIONS, message, {
        persistent: true,
        contentType: 'application/json',
      });

      logger.info(
        {
          type,
          bookingId: data.bookingId,
          queue: QUEUES.BOOKING_NOTIFICATIONS,
        },
        'Published notification to queue'
      );
    } catch (error) {
      logger.error({ error, type, bookingId: data.bookingId }, 'Failed to publish notification');
      throw error;
    }
  }

  /**
   * Schedules a reminder notification to be sent at a specific time.
   * @param bookingId - The booking ID to send a reminder for
   * @param reminderTime - When the reminder should be sent (ISO 8601)
   * @param payload - Additional reminder data
   */
  async scheduleReminder(
    bookingId: string,
    reminderTime: string,
    payload: Omit<ReminderPayload, 'bookingId' | 'reminderTime'>
  ): Promise<void> {
    await this.ensureConnected();

    const reminderPayload: ReminderPayload = {
      bookingId,
      reminderTime,
      ...payload,
    };

    // Calculate delay until reminder should be sent
    const delayMs = Math.max(0, new Date(reminderTime).getTime() - Date.now());

    const message = Buffer.from(JSON.stringify(reminderPayload));

    try {
      // For delayed messages, we use message TTL
      // In production, consider using RabbitMQ delayed message plugin
      if (delayMs > 0) {
        // Create a temporary delay queue
        const delayQueue = 'reminders-delay-' + delayMs;
        await this.channel!.assertQueue(delayQueue, {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': QUEUES.REMINDERS,
            'x-message-ttl': delayMs,
            'x-expires': delayMs + 60000, // Queue expires 1 minute after TTL
          },
        });

        this.channel!.sendToQueue(delayQueue, message, {
          persistent: true,
          contentType: 'application/json',
        });
      } else {
        // Send immediately if reminder time has passed
        this.channel!.sendToQueue(QUEUES.REMINDERS, message, {
          persistent: true,
          contentType: 'application/json',
        });
      }

      logger.info(
        {
          bookingId,
          reminderTime,
          delayMs,
          queue: QUEUES.REMINDERS,
        },
        'Scheduled reminder'
      );
    } catch (error) {
      logger.error({ error, bookingId, reminderTime }, 'Failed to schedule reminder');
      throw error;
    }
  }

  /**
   * Starts consuming booking notifications from the queue.
   * @param handler - Function to process each notification
   */
  async consumeNotifications(handler: NotificationHandler): Promise<void> {
    await this.ensureConnected();

    await this.channel!.consume(
      QUEUES.BOOKING_NOTIFICATIONS,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        const messageLogger = logger.child({
          queue: QUEUES.BOOKING_NOTIFICATIONS,
          messageId: msg.properties.messageId,
        });

        try {
          const payload = JSON.parse(msg.content.toString()) as BookingNotificationPayload;
          messageLogger.info({ type: payload.type, bookingId: payload.bookingId }, 'Processing notification');

          await handler(payload);

          this.channel!.ack(msg);
          messageLogger.info({ type: payload.type, bookingId: payload.bookingId }, 'Notification processed successfully');
        } catch (error) {
          messageLogger.error({ error }, 'Failed to process notification');

          // Reject and send to DLQ (no requeue to prevent infinite loops)
          this.channel!.nack(msg, false, false);
        }
      },
      { noAck: false }
    );

    logger.info({ queue: QUEUES.BOOKING_NOTIFICATIONS }, 'Started consuming notifications');
  }

  /**
   * Starts consuming reminder notifications from the queue.
   * @param handler - Function to process each reminder
   */
  async consumeReminders(handler: ReminderHandler): Promise<void> {
    await this.ensureConnected();

    await this.channel!.consume(
      QUEUES.REMINDERS,
      async (msg: ConsumeMessage | null) => {
        if (!msg) return;

        const messageLogger = logger.child({
          queue: QUEUES.REMINDERS,
          messageId: msg.properties.messageId,
        });

        try {
          const payload = JSON.parse(msg.content.toString()) as ReminderPayload;
          messageLogger.info({ bookingId: payload.bookingId }, 'Processing reminder');

          await handler(payload);

          this.channel!.ack(msg);
          messageLogger.info({ bookingId: payload.bookingId }, 'Reminder processed successfully');
        } catch (error) {
          messageLogger.error({ error }, 'Failed to process reminder');
          this.channel!.nack(msg, false, false);
        }
      },
      { noAck: false }
    );

    logger.info({ queue: QUEUES.REMINDERS }, 'Started consuming reminders');
  }

  /**
   * Ensures connection is established before performing operations.
   */
  private async ensureConnected(): Promise<void> {
    if (!this.connection || !this.channel) {
      await this.connect();
    }
  }

  /**
   * Gracefully closes the RabbitMQ connection.
   */
  async close(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
      logger.info('RabbitMQ connection closed gracefully');
    } catch (error) {
      logger.error({ error }, 'Error closing RabbitMQ connection');
    } finally {
      this.connection = null;
      this.channel = null;
    }
  }

  /**
   * Gets the current queue depth for monitoring.
   * @param queueName - Name of the queue to check
   * @returns Queue message count or null if unavailable
   */
  async getQueueDepth(queueName: string): Promise<number | null> {
    try {
      await this.ensureConnected();
      const queue = await this.channel!.checkQueue(queueName);
      return queue.messageCount;
    } catch (error) {
      logger.error({ error, queueName }, 'Failed to get queue depth');
      return null;
    }
  }

  /**
   * Health check for RabbitMQ connection.
   * @returns true if connected and channel is open
   */
  isHealthy(): boolean {
    return this.connection !== null && this.channel !== null;
  }
}

/** Singleton instance of QueueService for application-wide use */
export const queueService = new QueueService();
