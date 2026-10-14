import {
  initRabbitMQ,
  closeRabbitMQ,
  consumeQueue,
  publishToQueue,
  QUEUES,
  QueueMessage,
} from '../utils/rabbitmq.js';
import { pool, initDatabase, query } from '../utils/database.js';
import { redis } from '../utils/redis.js';
import { deliveryTracker } from '../services/delivery.js';
import { startOutboxRelay } from '../services/outbox.js';
import { createLogger } from '../utils/logger.js';
import { withCircuitBreaker, initializeCircuitBreakers, CircuitBreakerOpenError } from '../utils/circuitBreaker.js';
import { isRetryableError, RetryableError } from '../utils/retry.js';
import { queueDepthGauge } from '../utils/metrics.js';
import { processDelivery, Provider, ProviderResult } from './deliveryHandler.js';
import { Logger } from 'pino';

const log: Logger = createLogger('notification-worker');

interface DeviceToken {
  id: string;
  user_id: string;
  platform: string;
  token: string;
  active: boolean;
  last_used: Date;
}

interface UserRow {
  id?: string;
  email?: string;
  email_verified?: boolean;
  phone?: string;
  phone_verified?: boolean;
}

interface DeliveryResult extends ProviderResult {
  success: boolean;
  reason?: string;
  error?: string;
  retryable?: boolean;
  circuitOpen?: boolean;
  results?: Array<{
    deviceId: string;
    platform: string;
    success: boolean;
    error?: string;
    circuitOpen?: boolean;
  }>;
  email?: string;
  phone?: string;
  messageId?: string;
  verified?: boolean;
}

interface NotificationPayload {
  userId: string;
  content: Record<string, unknown>;
  notificationId: string;
}

// Simulated channel providers with circuit breaker and retry support
const providers = {
  async sendPush(notification: NotificationPayload): Promise<DeliveryResult> {
    const { userId, notificationId } = notification;

    log.debug({ userId, notificationId }, 'Sending push notification');

    // Get device tokens
    const devices = await query<DeviceToken>(
      `SELECT * FROM device_tokens WHERE user_id = $1 AND active = true`,
      [userId]
    );

    if (devices.rows.length === 0) {
      log.info({ userId, notificationId }, 'No devices registered for push');
      return { success: false, reason: 'no_devices', retryable: false };
    }

    // Send to each device with circuit breaker protection
    const results: Array<{
      deviceId: string;
      platform: string;
      success: boolean;
      error?: string;
      circuitOpen?: boolean;
    }> = [];

    for (const device of devices.rows) {
      try {
        // Wrap the actual send in circuit breaker
        await withCircuitBreaker('push', async () => {
          // Simulate 95% success rate
          if (Math.random() < 0.05) {
            const error = new Error('simulated_delivery_failure') as RetryableError;
            error.retryable = true;
            throw error;
          }

          // Simulate latency
          await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
        });

        results.push({
          deviceId: device.id,
          platform: device.platform,
          success: true,
        });

        // Update last_used
        await query(
          `UPDATE device_tokens SET last_used = NOW() WHERE id = $1`,
          [device.id]
        );
      } catch (error) {
        const isCircuitOpen = error instanceof CircuitBreakerOpenError;

        results.push({
          deviceId: device.id,
          platform: device.platform,
          success: false,
          error: (error as Error).message,
          circuitOpen: isCircuitOpen,
        });

        log.warn({
          deviceId: device.id,
          notificationId,
          error: (error as Error).message,
          circuitOpen: isCircuitOpen,
        }, 'Push delivery failed for device');
      }
    }

    const anySuccess = results.some(r => r.success);
    const allCircuitOpen = results.every(r => r.circuitOpen);

    return {
      success: anySuccess,
      results,
      // Every device failed: retry later; if the breaker rejected all of them,
      // the handler defers without spending an attempt.
      retryable: true,
      circuitOpen: allCircuitOpen,
    };
  },

  async sendEmail(notification: NotificationPayload): Promise<DeliveryResult> {
    const { userId, notificationId } = notification;

    log.debug({ userId, notificationId }, 'Sending email notification');

    // Get user email
    const user = await query<UserRow>(
      `SELECT email, email_verified FROM users WHERE id = $1`,
      [userId]
    );

    if (user.rows.length === 0 || !user.rows[0].email) {
      log.info({ userId, notificationId }, 'No email address for user');
      return { success: false, reason: 'no_email', retryable: false };
    }

    if (!user.rows[0].email_verified) {
      log.info({ userId, notificationId }, 'Email not verified');
      return { success: false, reason: 'email_not_verified', retryable: false };
    }

    try {
      // Wrap email send in circuit breaker
      const result = await withCircuitBreaker('email', async () => {
        // Simulate 98% success rate
        if (Math.random() < 0.02) {
          const error = new Error('simulated_smtp_error') as RetryableError;
          error.retryable = true;
          throw error;
        }

        // Simulate latency
        await new Promise(resolve => setTimeout(resolve, Math.random() * 100));

        return {
          messageId: `msg_${Date.now()}`,
        };
      });

      return {
        success: true,
        email: user.rows[0].email,
        messageId: result.messageId,
      };
    } catch (error) {
      const isCircuitOpen = error instanceof CircuitBreakerOpenError;

      log.warn({
        userId,
        notificationId,
        error: (error as Error).message,
        circuitOpen: isCircuitOpen,
      }, 'Email delivery failed');

      return {
        success: false,
        email: user.rows[0].email,
        error: (error as Error).message,
        circuitOpen: isCircuitOpen,
        retryable: isCircuitOpen || isRetryableError(error as RetryableError),
      };
    }
  },

  async sendSMS(notification: NotificationPayload): Promise<DeliveryResult> {
    const { userId, notificationId } = notification;

    log.debug({ userId, notificationId }, 'Sending SMS notification');

    // Get user phone
    const user = await query<UserRow>(
      `SELECT phone, phone_verified FROM users WHERE id = $1`,
      [userId]
    );

    if (user.rows.length === 0 || !user.rows[0].phone) {
      log.info({ userId, notificationId }, 'No phone number for user');
      return { success: false, reason: 'no_phone', retryable: false };
    }

    try {
      // Wrap SMS send in circuit breaker
      await withCircuitBreaker('sms', async () => {
        // Simulate 90% success rate
        if (Math.random() < 0.1) {
          const error = new Error('simulated_sms_error') as RetryableError;
          error.retryable = true;
          throw error;
        }

        // Simulate latency
        await new Promise(resolve => setTimeout(resolve, Math.random() * 150));
      });

      return {
        success: true,
        phone: user.rows[0].phone,
        verified: user.rows[0].phone_verified,
      };
    } catch (error) {
      const isCircuitOpen = error instanceof CircuitBreakerOpenError;

      log.warn({
        userId,
        notificationId,
        error: (error as Error).message,
        circuitOpen: isCircuitOpen,
      }, 'SMS delivery failed');

      return {
        success: false,
        phone: user.rows[0].phone,
        error: (error as Error).message,
        circuitOpen: isCircuitOpen,
        retryable: isCircuitOpen || isRetryableError(error as RetryableError),
      };
    }
  },
};

const channelProviders: Record<string, Provider> = {
  push: (delivery) => providers.sendPush(delivery),
  email: (delivery) => providers.sendEmail(delivery),
  sms: (delivery) => providers.sendSMS(delivery),
};

interface QueueConfig {
  queue: string;
  prefetch: number;
  channel: string;
  priority: string;
}

let relay: { stop: () => Promise<void> } | null = null;
let reaper: NodeJS.Timeout | null = null;

// Start workers for all queues
async function startWorkers(): Promise<void> {
  log.info('Starting notification workers...');

  await initDatabase();
  log.info('Database connected');

  initializeCircuitBreakers();
  log.info('Circuit breakers initialized');

  // Prefetch per queue: critical consumers get the most in-flight capacity, and
  // SMS the least because carriers throttle hardest.
  const queues: QueueConfig[] = [
    { queue: QUEUES.PUSH_CRITICAL, prefetch: 50, channel: 'push', priority: 'critical' },
    { queue: QUEUES.PUSH_HIGH, prefetch: 30, channel: 'push', priority: 'high' },
    { queue: QUEUES.PUSH_NORMAL, prefetch: 20, channel: 'push', priority: 'normal' },
    { queue: QUEUES.PUSH_LOW, prefetch: 10, channel: 'push', priority: 'low' },
    { queue: QUEUES.EMAIL_CRITICAL, prefetch: 20, channel: 'email', priority: 'critical' },
    { queue: QUEUES.EMAIL_HIGH, prefetch: 15, channel: 'email', priority: 'high' },
    { queue: QUEUES.EMAIL_NORMAL, prefetch: 10, channel: 'email', priority: 'normal' },
    { queue: QUEUES.EMAIL_LOW, prefetch: 5, channel: 'email', priority: 'low' },
    { queue: QUEUES.SMS_CRITICAL, prefetch: 10, channel: 'sms', priority: 'critical' },
    { queue: QUEUES.SMS_HIGH, prefetch: 5, channel: 'sms', priority: 'high' },
    { queue: QUEUES.SMS_NORMAL, prefetch: 3, channel: 'sms', priority: 'normal' },
    { queue: QUEUES.SMS_LOW, prefetch: 2, channel: 'sms', priority: 'low' },
  ];

  // Registered before connecting so the first connect and every reconnect attach them.
  for (const { queue, prefetch, priority } of queues) {
    await consumeQueue(queue, (message: QueueMessage) => processDelivery(message, channelProviders), { prefetch });
    queueDepthGauge.labels(queue, priority).set(0);
  }

  // Dead letters are recorded as events; anything malformed is acked after logging.
  await consumeQueue(QUEUES.DEAD_LETTER, async (message: QueueMessage) => {
    log.warn({ notificationId: message.notificationId, channel: message.channel }, 'Dead letter received');
    try {
      await query(
        `INSERT INTO notification_events (notification_id, channel, event_type, metadata)
         VALUES ($1, $2, 'dead_letter', $3)`,
        [message.notificationId, message.channel, JSON.stringify(message)]
      );
    } catch (error) {
      log.error({ err: error }, 'Could not record dead letter');
    }
    return 'ack';
  }, { prefetch: 1, onMalformed: 'ack' });

  await initRabbitMQ({ retry: true });
  log.info('RabbitMQ connected; consumers attached');

  // The relay publishes due outbox rows: new sends, scheduled and quiet-hours
  // deliveries, and retries. Several worker processes can run it at once.
  relay = startOutboxRelay({ publish: publishToQueue });

  // Recover deliveries whose worker died mid-send.
  reaper = setInterval(() => {
    deliveryTracker.reapExpiredLeases()
      .then((count) => { if (count > 0) log.warn({ count }, 'Re-enqueued deliveries with expired leases'); })
      .catch((error: Error) => log.error({ err: error }, 'Lease reaper failed'));
  }, 15000);

  log.info('All workers started. Waiting for messages...');
}

// Graceful shutdown: stop publishing, stop consuming, then close stores.
const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'Received shutdown signal, shutting down workers...');

  try {
    if (reaper) clearInterval(reaper);
    await relay?.stop();
    await closeRabbitMQ();
    await pool.end();
    await redis.quit();
    log.info('Worker shutdown complete');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'Error during worker shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

startWorkers().catch((error: Error) => {
  log.fatal({ err: error }, 'Failed to start workers');
  process.exit(1);
});
