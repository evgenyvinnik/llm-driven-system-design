/**
 * Analytics Worker
 *
 * Consumes click events from RabbitMQ and persists them to PostgreSQL.
 * This decouples analytics recording from the redirect path, ensuring
 * fast redirects even under high load.
 *
 * Delivery is at-least-once; persistence is idempotent (event_id unique index), so
 * redeliveries never double count. Failures are retried with a delay and, after
 * CLICK_EVENTS_MAX_ATTEMPTS, moved to the click-events.dlq queue (see utils/queue.ts).
 *
 * Set WORKER_METRICS_PORT to expose Prometheus metrics (retries, dead letters,
 * duplicates) at http://localhost:<port>/metrics.
 *
 * Run with: npm run dev:worker
 */

import http from 'http';
import { connectQueue, consumeClickEvents, closeQueue } from '../utils/queue.js';
import { testConnection, closePool } from '../utils/database.js';
import { recordClickEvent } from '../services/analyticsService.js';
import { classifyProcessingError } from '../utils/clickEvents.js';
import { metricsRegistry } from '../utils/metrics.js';
import { SHUTDOWN_TIMEOUT_MS } from '../config.js';
import type { ClickEventMessage } from '../models/types.js';
import logger from '../utils/logger.js';

/**
 * Worker state for graceful shutdown.
 */
let isShuttingDown = false;
let metricsServer: http.Server | null = null;

/**
 * Processes a single click event from the queue.
 * Inserts the event and increments the click count in one transaction, unless this
 * event_id was already recorded (redelivery), in which case nothing changes.
 */
async function processClickEvent(event: ClickEventMessage): Promise<void> {
  const recorded = await recordClickEvent(event);
  if (recorded) {
    logger.info(
      { short_code: event.short_code, device_type: event.device_type, event_id: event.event_id },
      'Click event persisted'
    );
  }
}

/**
 * Serves the Prometheus registry on its own port (the worker has no Express app).
 * @param port - Port to listen on
 */
function startMetricsServer(port: number): void {
  metricsServer = http.createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.statusCode = 404;
      res.end();
      return;
    }
    metricsRegistry
      .metrics()
      .then((body) => {
        res.setHeader('Content-Type', metricsRegistry.contentType);
        res.end(body);
      })
      .catch((error) => {
        logger.error({ err: error }, 'Failed to collect worker metrics');
        res.statusCode = 500;
        res.end();
      });
  });
  metricsServer.listen(port, () => {
    logger.info({ port }, 'Worker metrics endpoint listening');
  });
}

/**
 * Graceful shutdown handler.
 * Cancels the consumer, waits for in-flight messages, then closes queue and database
 * connections. Unacked messages go back to the queue and are deduplicated on redelivery.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down analytics worker');
  setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    await closeQueue();
    metricsServer?.close();
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

  // Handle shutdown signals (registered first so Ctrl+C works while waiting for RabbitMQ)
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    logger.error('Failed to connect to database, exiting');
    process.exit(1);
  }

  const metricsPort = parseInt(process.env.WORKER_METRICS_PORT || '', 10);
  if (Number.isInteger(metricsPort) && metricsPort > 0) {
    startMetricsServer(metricsPort);
  }

  // Register the consumer before connecting: it is (re)attached on every connect, so a
  // dropped connection no longer leaves the worker idle.
  await consumeClickEvents(processClickEvent, classifyProcessingError);

  // Connect to RabbitMQ; on failure the queue module keeps retrying with backoff.
  const connected = await connectQueue();
  if (!connected) {
    logger.warn('RabbitMQ not reachable yet; retrying in the background, consumption starts once connected');
  }

  logger.info('Analytics worker is running. Press Ctrl+C to stop.');
}

// Start the worker
main().catch((error) => {
  logger.error({ err: error }, 'Analytics worker failed');
  process.exit(1);
});
