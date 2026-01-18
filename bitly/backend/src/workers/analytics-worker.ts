/**
 * Analytics Worker
 *
 * Consumes click events from RabbitMQ and persists them to PostgreSQL.
 * This decouples analytics recording from the redirect path, ensuring
 * fast redirects even under high load.
 *
 * Run with: npm run dev:worker
 */

import { connectQueue, consumeClickEvents, closeQueue, ClickEventMessage } from '../utils/queue.js';
import { query, testConnection, closePool } from '../utils/database.js';
import { incrementClickCount } from '../services/urlService.js';
import logger from '../utils/logger.js';

/**
 * Worker state for graceful shutdown.
 */
let isShuttingDown = false;

/**
 * Processes a single click event from the queue.
 * Inserts the event into the database and increments the click count.
 */
async function processClickEvent(event: ClickEventMessage): Promise<void> {
  // Insert click event into database
  await query(
    `INSERT INTO click_events (short_code, referrer, user_agent, ip_address, device_type, clicked_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.short_code,
      event.referrer || null,
      event.user_agent || null,
      event.ip_address || null,
      event.device_type,
      new Date(event.timestamp),
    ]
  );

  // Increment click count on the URL
  await incrementClickCount(event.short_code);

  logger.info({ short_code: event.short_code, device_type: event.device_type }, 'Click event persisted');
}

/**
 * Graceful shutdown handler.
 * Closes queue and database connections before exiting.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down analytics worker');

  try {
    await closeQueue();
    await closePool();
    logger.info('Analytics worker shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

/**
 * Main entry point for the analytics worker.
 * Establishes connections and starts consuming messages.
 */
async function main(): Promise<void> {
  logger.info('Starting analytics worker');

  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    logger.error('Failed to connect to database, exiting');
    process.exit(1);
  }

  // Connect to RabbitMQ with retry
  let connected = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!connected && attempts < maxAttempts) {
    connected = await connectQueue();
    if (!connected) {
      attempts++;
      logger.warn({ attempt: attempts, maxAttempts }, 'Failed to connect to RabbitMQ, retrying...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (!connected) {
    logger.error('Failed to connect to RabbitMQ after max attempts, exiting');
    process.exit(1);
  }

  // Start consuming click events
  await consumeClickEvents(processClickEvent);

  logger.info('Analytics worker is running. Press Ctrl+C to stop.');

  // Handle shutdown signals
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start the worker
main().catch((error) => {
  logger.error({ err: error }, 'Analytics worker failed');
  process.exit(1);
});
