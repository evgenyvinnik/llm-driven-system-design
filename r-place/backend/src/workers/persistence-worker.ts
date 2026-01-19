/**
 * Persistence Worker
 *
 * Consumes pixel events from RabbitMQ and batch inserts them
 * into PostgreSQL for historical records and analytics.
 *
 * Features:
 * - Batch processing for efficiency
 * - Automatic retries on failure
 * - Metrics for monitoring
 * - Graceful shutdown
 */
import {
  connectQueue,
  consumePixelEvents,
  closeQueue,
  PixelEventMessage,
} from '../shared/queue.js';
import { pool, query } from '../services/database.js';
import { logger } from '../shared/logger.js';
import { Counter, Histogram } from 'prom-client';
import { metricsRegistry, getMetrics, getMetricsContentType } from '../shared/metrics.js';
import express from 'express';
import { Channel } from 'amqplib';

/** Worker configuration. */
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '100');
const BATCH_TIMEOUT_MS = parseInt(process.env.BATCH_TIMEOUT_MS || '1000');
const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9091');

/** Metrics for the persistence worker. */
const pixelEventsPersistedTotal = new Counter({
  name: 'rplace_persistence_events_persisted_total',
  help: 'Total number of pixel events persisted to PostgreSQL',
  registers: [metricsRegistry],
});

const persistenceBatchSize = new Histogram({
  name: 'rplace_persistence_batch_size',
  help: 'Size of batches persisted',
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [metricsRegistry],
});

const persistenceDuration = new Histogram({
  name: 'rplace_persistence_duration_seconds',
  help: 'Time to persist a batch of events',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry],
});

const persistenceErrors = new Counter({
  name: 'rplace_persistence_errors_total',
  help: 'Total number of persistence errors',
  registers: [metricsRegistry],
});

/** Consumer channel reference for graceful shutdown. */
let consumerChannel: Channel | null = null;

/**
 * Batch inserts pixel events into PostgreSQL.
 *
 * @param events - Array of pixel events to persist.
 */
async function persistPixelEvents(events: PixelEventMessage[]): Promise<void> {
  if (events.length === 0) return;

  const start = Date.now();

  try {
    // Build a multi-row INSERT statement
    const values: unknown[] = [];
    const placeholders: string[] = [];

    events.forEach((event, index) => {
      const offset = index * 5;
      placeholders.push(
        '($' + (offset + 1) + ', $' + (offset + 2) + ', $' + (offset + 3) + ', $' + (offset + 4) + ', $' + (offset + 5) + ')'
      );
      values.push(
        event.x,
        event.y,
        event.color,
        event.userId,
        new Date(event.timestamp)
      );
    });

    const sql =
      'INSERT INTO pixel_events (x, y, color, user_id, placed_at) VALUES ' +
      placeholders.join(', ');

    await query(sql, values);

    const duration = (Date.now() - start) / 1000;

    pixelEventsPersistedTotal.inc(events.length);
    persistenceBatchSize.observe(events.length);
    persistenceDuration.observe(duration);

    logger.info(
      { batchSize: events.length, durationMs: Math.round(duration * 1000) },
      'Batch persisted to PostgreSQL'
    );
  } catch (error) {
    persistenceErrors.inc();
    logger.error({ error, batchSize: events.length }, 'Failed to persist batch');
    throw error; // Re-throw to trigger nack
  }
}

/**
 * Starts the persistence worker.
 */
async function start(): Promise<void> {
  logger.info(
    { batchSize: BATCH_SIZE, batchTimeoutMs: BATCH_TIMEOUT_MS },
    'Starting persistence worker'
  );

  try {
    // Connect to RabbitMQ
    await connectQueue();

    // Start consuming pixel events
    consumerChannel = await consumePixelEvents(
      persistPixelEvents,
      BATCH_SIZE,
      BATCH_TIMEOUT_MS
    );

    // Start metrics server
    const app = express();

    app.get('/health', (req, res) => {
      res.json({ status: 'healthy', worker: 'persistence' });
    });

    app.get('/metrics', async (req, res) => {
      try {
        const metrics = await getMetrics();
        res.set('Content-Type', getMetricsContentType());
        res.send(metrics);
      } catch (_error) {
        res.status(500).send('Failed to collect metrics');
      }
    });

    app.listen(METRICS_PORT, () => {
      logger.info({ port: METRICS_PORT }, 'Persistence worker metrics server started');
    });

    logger.info('Persistence worker started successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to start persistence worker');
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Persistence worker shutting down');

  try {
    if (consumerChannel) {
      await consumerChannel.close();
    }
    await closeQueue();
    await pool.end();
    logger.info('Persistence worker shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception in persistence worker');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection in persistence worker');
});

start();
