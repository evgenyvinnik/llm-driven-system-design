import { initRabbitMQ, consumeQueue, QUEUES } from '../utils/rabbitmq.js';
import { pool, initDatabase } from '../utils/database.js';
import { redis } from '../utils/redis.js';
import { query } from '../utils/database.js';
import { deliveryTracker } from '../services/delivery.js';

// Simulated channel providers
const providers = {
  async sendPush(notification) {
    // Simulate push notification delivery
    console.log(`[PUSH] Sending to user ${notification.userId}:`, notification.content);

    // Get device tokens
    const devices = await query(
      `SELECT * FROM device_tokens WHERE user_id = $1 AND active = true`,
      [notification.userId]
    );

    if (devices.rows.length === 0) {
      return { success: false, reason: 'no_devices' };
    }

    // Simulate sending to each device
    const results = [];
    for (const device of devices.rows) {
      // Simulate 95% success rate
      const success = Math.random() > 0.05;

      results.push({
        deviceId: device.id,
        platform: device.platform,
        success,
        error: success ? null : 'simulated_delivery_failure',
      });

      // Update last_used
      if (success) {
        await query(
          `UPDATE device_tokens SET last_used = NOW() WHERE id = $1`,
          [device.id]
        );
      }
    }

    const anySuccess = results.some((r) => r.success);
    return { success: anySuccess, results };
  },

  async sendEmail(notification) {
    // Simulate email delivery
    console.log(`[EMAIL] Sending to user ${notification.userId}:`, notification.content);

    // Get user email
    const user = await query(
      `SELECT email, email_verified FROM users WHERE id = $1`,
      [notification.userId]
    );

    if (user.rows.length === 0 || !user.rows[0].email) {
      return { success: false, reason: 'no_email' };
    }

    if (!user.rows[0].email_verified) {
      return { success: false, reason: 'email_not_verified' };
    }

    // Simulate 98% success rate for email
    const success = Math.random() > 0.02;

    // Simulate some latency
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));

    return {
      success,
      email: user.rows[0].email,
      messageId: success ? `msg_${Date.now()}` : null,
      error: success ? null : 'simulated_smtp_error',
    };
  },

  async sendSMS(notification) {
    // Simulate SMS delivery
    console.log(`[SMS] Sending to user ${notification.userId}:`, notification.content);

    // Get user phone
    const user = await query(
      `SELECT phone, phone_verified FROM users WHERE id = $1`,
      [notification.userId]
    );

    if (user.rows.length === 0 || !user.rows[0].phone) {
      return { success: false, reason: 'no_phone' };
    }

    // SMS works without verification but we note it
    const verified = user.rows[0].phone_verified;

    // Simulate 90% success rate for SMS
    const success = Math.random() > 0.1;

    return {
      success,
      phone: user.rows[0].phone,
      verified,
      error: success ? null : 'simulated_sms_error',
    };
  },
};

// Process a notification from the queue
async function processNotification(message) {
  const { notificationId, userId, channel, content, priority, queuedAt, retryCount = 0 } = message;

  console.log(`Processing ${channel} notification ${notificationId} (attempt ${retryCount + 1})`);

  const startTime = Date.now();

  try {
    let result;

    switch (channel) {
      case 'push':
        result = await providers.sendPush({ userId, content, notificationId });
        break;
      case 'email':
        result = await providers.sendEmail({ userId, content, notificationId });
        break;
      case 'sms':
        result = await providers.sendSMS({ userId, content, notificationId });
        break;
      default:
        throw new Error(`Unknown channel: ${channel}`);
    }

    const processingTime = Date.now() - startTime;

    // Update delivery status
    if (result.success) {
      await deliveryTracker.updateStatus(notificationId, channel, 'sent', {
        ...result,
        processingTime,
        queuedAt,
        deliveredAt: Date.now(),
      });

      console.log(`[SUCCESS] ${channel} notification ${notificationId} delivered in ${processingTime}ms`);
    } else {
      // Check if we should retry
      if (retryCount < 3 && isRetryableError(result.reason)) {
        const nextRetryDelay = Math.pow(2, retryCount + 1) * 1000; // Exponential backoff

        await deliveryTracker.updateStatus(notificationId, channel, 'pending', {
          ...result,
          retryCount: retryCount + 1,
          nextRetryAt: Date.now() + nextRetryDelay,
          error: result.error || result.reason,
        });

        console.log(`[RETRY] ${channel} notification ${notificationId} will retry in ${nextRetryDelay}ms`);

        // The message will be requeued by the queue consumer
        throw new Error(`Retry needed: ${result.reason}`);
      } else {
        // Mark as failed
        await deliveryTracker.updateStatus(notificationId, channel, 'failed', {
          ...result,
          retryCount,
          error: result.error || result.reason,
          processingTime,
        });

        console.log(`[FAILED] ${channel} notification ${notificationId}: ${result.reason}`);
      }
    }
  } catch (error) {
    console.error(`Error processing notification ${notificationId}:`, error);
    throw error; // Re-throw to trigger retry logic in queue consumer
  }
}

function isRetryableError(reason) {
  const nonRetryable = ['no_devices', 'no_email', 'no_phone', 'email_not_verified'];
  return !nonRetryable.includes(reason);
}

// Start workers for all queues
async function startWorkers() {
  console.log('Starting notification workers...');

  await initDatabase();
  console.log('Database connected');

  await initRabbitMQ();
  console.log('RabbitMQ connected');

  // Start consumers for each queue
  const queues = [
    // Push queues (higher concurrency)
    { queue: QUEUES.PUSH_CRITICAL, prefetch: 50 },
    { queue: QUEUES.PUSH_HIGH, prefetch: 30 },
    { queue: QUEUES.PUSH_NORMAL, prefetch: 20 },
    { queue: QUEUES.PUSH_LOW, prefetch: 10 },

    // Email queues (medium concurrency)
    { queue: QUEUES.EMAIL_CRITICAL, prefetch: 20 },
    { queue: QUEUES.EMAIL_HIGH, prefetch: 15 },
    { queue: QUEUES.EMAIL_NORMAL, prefetch: 10 },
    { queue: QUEUES.EMAIL_LOW, prefetch: 5 },

    // SMS queues (lower concurrency due to rate limits)
    { queue: QUEUES.SMS_CRITICAL, prefetch: 10 },
    { queue: QUEUES.SMS_HIGH, prefetch: 5 },
    { queue: QUEUES.SMS_NORMAL, prefetch: 3 },
    { queue: QUEUES.SMS_LOW, prefetch: 2 },
  ];

  for (const { queue, prefetch } of queues) {
    await consumeQueue(queue, processNotification, { prefetch });
    console.log(`Worker started for queue: ${queue}`);
  }

  // Dead letter queue processor
  await consumeQueue(QUEUES.DEAD_LETTER, async (message) => {
    console.log('[DLQ] Dead letter received:', message);

    // Log to database for analysis
    await query(
      `INSERT INTO notification_events (notification_id, channel, event_type, metadata)
       VALUES ($1, $2, 'dead_letter', $3)`,
      [message.notificationId, message.channel, JSON.stringify(message)]
    );
  }, { prefetch: 1 });

  console.log('All workers started. Waiting for messages...');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down workers...');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

startWorkers().catch((error) => {
  console.error('Failed to start workers:', error);
  process.exit(1);
});
