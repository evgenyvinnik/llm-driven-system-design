import pool from '../db/pool.js';
import redis from '../db/redis.js';
import {
  consumeNotifications,
  NotificationMessage,
  closeConnection,
} from '../shared/queue.js';
import { createComponentLogger, dbQueryDuration } from '../shared/index.js';

/**
 * Notification Worker
 *
 * Consumes notifications from RabbitMQ and delivers them to users.
 * This decouples notification creation from delivery, enabling:
 * - Reliable notification delivery with retries
 * - Rate limiting of notifications per user
 * - Multiple delivery channels (database, real-time, push)
 *
 * RESPONSIBILITIES:
 * 1. Store notification in PostgreSQL
 * 2. Publish to Redis pub/sub for real-time delivery
 * 3. Future: Send push notifications, emails, etc.
 */

const log = createComponentLogger('notification-worker');

/**
 * Process a single notification message.
 * Stores in database and broadcasts via Redis pub/sub.
 */
async function processNotification(
  data: NotificationMessage,
  ack: () => void,
  nack: (requeue?: boolean) => void
): Promise<void> {
  const { user_id, device_id, type, title, message, data: notificationData, created_at } = data;

  log.debug({ userId: user_id, type, title }, 'Processing notification');

  const timer = dbQueryDuration.startTimer({ operation: 'insert', table: 'notifications' });

  try {
    // Store the notification in the database
    const result = await pool.query(
      `INSERT INTO notifications (user_id, device_id, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id, device_id, type, title, message, notificationData]
    );
    timer();

    const notification = result.rows[0];

    // Publish to Redis for real-time updates
    await redis.publish(`notifications:${user_id}`, JSON.stringify(notification));

    log.info(
      {
        notificationId: notification.id,
        userId: user_id,
        type,
        processingTime: Date.now() - created_at,
      },
      'Notification processed and delivered'
    );

    // Acknowledge the message
    ack();
  } catch (error) {
    timer();
    log.error({ error, userId: user_id, type }, 'Failed to process notification');

    // Don't requeue - log for investigation
    nack(false);
  }
}

/**
 * Graceful shutdown handler.
 */
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Received shutdown signal, closing connections');

  try {
    await closeConnection();
    await pool.end();
    await redis.quit();
    log.info('Connections closed, exiting');
    process.exit(0);
  } catch (error) {
    log.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

/**
 * Main entry point for the notification worker.
 */
async function main(): Promise<void> {
  log.info('Starting notification worker');

  // Register shutdown handlers
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // Start consuming notifications
    await consumeNotifications(processNotification);
    log.info('Notification worker is running, waiting for messages...');
  } catch (error) {
    log.error({ error }, 'Failed to start notification worker');
    process.exit(1);
  }
}

// Start the worker
main().catch((error) => {
  log.error({ error }, 'Unhandled error in notification worker');
  process.exit(1);
});
