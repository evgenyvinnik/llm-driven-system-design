import { initRabbitMQ, consumeQueue, QUEUES } from '../utils/rabbitmq.js';
import { pool, initDatabase } from '../utils/database.js';
import { redis } from '../utils/redis.js';
import { query } from '../utils/database.js';
import { deliveryTracker } from '../services/delivery.js';
import { createLogger } from '../utils/logger.js';
import { withCircuitBreaker, initializeCircuitBreakers, CircuitBreakerOpenError } from '../utils/circuitBreaker.js';
import { withRetry, isRetryableError, RetryPresets } from '../utils/retry.js';
import {
  notificationsSentCounter,
  deliveryAttemptsCounter,
  processingDurationHistogram,
  queueDepthGauge,
} from '../utils/metrics.js';

const log = createLogger('notification-worker');

// Simulated channel providers with circuit breaker and retry support
const providers = {
  async sendPush(notification) {
    const { userId, content, notificationId } = notification;

    log.debug({ userId, notificationId }, 'Sending push notification');

    // Get device tokens
    const devices = await query(
      `SELECT * FROM device_tokens WHERE user_id = $1 AND active = true`,
      [userId]
    );

    if (devices.rows.length === 0) {
      log.info({ userId, notificationId }, 'No devices registered for push');
      return { success: false, reason: 'no_devices', retryable: false };
    }

    // Send to each device with circuit breaker protection
    const results = [];
    for (const device of devices.rows) {
      try {
        // Wrap the actual send in circuit breaker
        await withCircuitBreaker('push', async () => {
          // Simulate 95% success rate
          if (Math.random() < 0.05) {
            const error = new Error('simulated_delivery_failure');
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
          error: error.message,
          circuitOpen: isCircuitOpen,
        });

        log.warn({
          deviceId: device.id,
          notificationId,
          error: error.message,
          circuitOpen: isCircuitOpen,
        }, 'Push delivery failed for device');
      }
    }

    const anySuccess = results.some(r => r.success);
    const allCircuitOpen = results.every(r => r.circuitOpen);

    return {
      success: anySuccess,
      results,
      retryable: allCircuitOpen, // Retry if all failures were due to circuit breaker
    };
  },

  async sendEmail(notification) {
    const { userId, content, notificationId } = notification;

    log.debug({ userId, notificationId }, 'Sending email notification');

    // Get user email
    const user = await query(
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
          const error = new Error('simulated_smtp_error');
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
        error: error.message,
        circuitOpen: isCircuitOpen,
      }, 'Email delivery failed');

      return {
        success: false,
        email: user.rows[0].email,
        error: error.message,
        retryable: isCircuitOpen || isRetryableError(error),
      };
    }
  },

  async sendSMS(notification) {
    const { userId, content, notificationId } = notification;

    log.debug({ userId, notificationId }, 'Sending SMS notification');

    // Get user phone
    const user = await query(
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
          const error = new Error('simulated_sms_error');
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
        error: error.message,
        circuitOpen: isCircuitOpen,
      }, 'SMS delivery failed');

      return {
        success: false,
        phone: user.rows[0].phone,
        error: error.message,
        retryable: isCircuitOpen || isRetryableError(error),
      };
    }
  },
};

// Non-retryable error reasons
const NON_RETRYABLE_REASONS = ['no_devices', 'no_email', 'no_phone', 'email_not_verified'];

function isRetryableResult(result) {
  if (result.retryable === false) {
    return false;
  }
  if (result.retryable === true) {
    return true;
  }
  return !NON_RETRYABLE_REASONS.includes(result.reason);
}

// Process a notification from the queue
async function processNotification(message) {
  const {
    notificationId,
    userId,
    channel,
    content,
    priority,
    queuedAt,
    retryCount = 0,
  } = message;

  const logContext = { notificationId, userId, channel, priority, retryCount };

  log.info(logContext, `Processing ${channel} notification (attempt ${retryCount + 1})`);

  const startTime = Date.now();
  const timer = processingDurationHistogram.labels(channel, priority).startTimer();

  try {
    // Execute the delivery with retry wrapper
    const result = await withRetry(
      async () => {
        let deliveryResult;

        switch (channel) {
          case 'push':
            deliveryResult = await providers.sendPush({ userId, content, notificationId });
            break;
          case 'email':
            deliveryResult = await providers.sendEmail({ userId, content, notificationId });
            break;
          case 'sms':
            deliveryResult = await providers.sendSMS({ userId, content, notificationId });
            break;
          default:
            throw new Error(`Unknown channel: ${channel}`);
        }

        // If delivery failed but is retryable, throw to trigger retry
        if (!deliveryResult.success && isRetryableResult(deliveryResult)) {
          const error = new Error(deliveryResult.error || deliveryResult.reason);
          error.retryable = true;
          error.deliveryResult = deliveryResult;
          throw error;
        }

        return deliveryResult;
      },
      {
        ...RetryPresets.fast,
        maxRetries: 2, // Quick retries within the worker, main retry via queue
        context: { channel, notificationId },
      }
    );

    const processingTime = Date.now() - startTime;
    timer();

    // Update delivery status based on result
    if (result.success) {
      await deliveryTracker.updateStatus(notificationId, channel, 'sent', {
        ...result,
        processingTime,
        queuedAt,
        deliveredAt: Date.now(),
      });

      // Update metrics
      notificationsSentCounter.labels(channel, priority, 'sent').inc();
      deliveryAttemptsCounter.labels(channel, 'true').inc();

      log.info({
        ...logContext,
        processingTime,
      }, `Notification delivered successfully`);
    } else {
      // Non-retryable failure
      await deliveryTracker.updateStatus(notificationId, channel, 'failed', {
        ...result,
        retryCount,
        error: result.error || result.reason,
        processingTime,
      });

      // Update metrics
      notificationsSentCounter.labels(channel, priority, 'failed').inc();
      deliveryAttemptsCounter.labels(channel, 'false').inc();

      log.warn({
        ...logContext,
        reason: result.reason,
        processingTime,
      }, `Notification failed (non-retryable)`);
    }
  } catch (error) {
    const processingTime = Date.now() - startTime;
    timer();

    // Error during processing - check if we should trigger queue-level retry
    const shouldRetry = retryCount < 3 && isRetryableError(error);

    if (shouldRetry) {
      await deliveryTracker.updateStatus(notificationId, channel, 'pending', {
        retryCount: retryCount + 1,
        error: error.message,
        processingTime,
      });

      log.info({
        ...logContext,
        error: error.message,
        nextRetryCount: retryCount + 1,
      }, 'Notification will be retried via queue');

      // Re-throw to trigger queue-level retry
      throw error;
    } else {
      // Max retries exceeded or non-retryable error
      await deliveryTracker.updateStatus(notificationId, channel, 'failed', {
        retryCount,
        error: error.message,
        processingTime,
        exhaustedRetries: retryCount >= 3,
      });

      // Update metrics
      notificationsSentCounter.labels(channel, priority, 'failed').inc();
      deliveryAttemptsCounter.labels(channel, 'false').inc();

      log.error({
        ...logContext,
        err: error,
        processingTime,
      }, 'Notification failed after all retries');
    }
  }
}

// Start workers for all queues
async function startWorkers() {
  log.info('Starting notification workers...');

  await initDatabase();
  log.info('Database connected');

  await initRabbitMQ();
  log.info('RabbitMQ connected');

  // Initialize circuit breakers
  initializeCircuitBreakers();
  log.info('Circuit breakers initialized');

  // Start consumers for each queue
  const queues = [
    // Push queues (higher concurrency)
    { queue: QUEUES.PUSH_CRITICAL, prefetch: 50, channel: 'push', priority: 'critical' },
    { queue: QUEUES.PUSH_HIGH, prefetch: 30, channel: 'push', priority: 'high' },
    { queue: QUEUES.PUSH_NORMAL, prefetch: 20, channel: 'push', priority: 'normal' },
    { queue: QUEUES.PUSH_LOW, prefetch: 10, channel: 'push', priority: 'low' },

    // Email queues (medium concurrency)
    { queue: QUEUES.EMAIL_CRITICAL, prefetch: 20, channel: 'email', priority: 'critical' },
    { queue: QUEUES.EMAIL_HIGH, prefetch: 15, channel: 'email', priority: 'high' },
    { queue: QUEUES.EMAIL_NORMAL, prefetch: 10, channel: 'email', priority: 'normal' },
    { queue: QUEUES.EMAIL_LOW, prefetch: 5, channel: 'email', priority: 'low' },

    // SMS queues (lower concurrency due to rate limits)
    { queue: QUEUES.SMS_CRITICAL, prefetch: 10, channel: 'sms', priority: 'critical' },
    { queue: QUEUES.SMS_HIGH, prefetch: 5, channel: 'sms', priority: 'high' },
    { queue: QUEUES.SMS_NORMAL, prefetch: 3, channel: 'sms', priority: 'normal' },
    { queue: QUEUES.SMS_LOW, prefetch: 2, channel: 'sms', priority: 'low' },
  ];

  for (const { queue, prefetch, channel, priority } of queues) {
    await consumeQueue(queue, processNotification, { prefetch });

    // Initialize queue depth gauge
    queueDepthGauge.labels(queue, priority).set(0);

    log.info({ queue, prefetch }, `Worker started for queue`);
  }

  // Dead letter queue processor
  await consumeQueue(QUEUES.DEAD_LETTER, async (message) => {
    log.warn({ message }, 'Dead letter received');

    // Log to database for analysis
    await query(
      `INSERT INTO notification_events (notification_id, channel, event_type, metadata)
       VALUES ($1, $2, 'dead_letter', $3)`,
      [message.notificationId, message.channel, JSON.stringify(message)]
    );
  }, { prefetch: 1 });

  log.info('All workers started. Waiting for messages...');
}

// Graceful shutdown
const shutdown = async (signal) => {
  log.info({ signal }, 'Received shutdown signal, shutting down workers...');

  try {
    await pool.end();
    log.info('Database pool closed');

    await redis.quit();
    log.info('Redis connection closed');

    log.info('Worker shutdown complete');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'Error during worker shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startWorkers().catch((error) => {
  log.fatal({ err: error }, 'Failed to start workers');
  process.exit(1);
});
