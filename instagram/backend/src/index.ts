import type { Server } from 'node:http';
import { app, markShuttingDown } from './app.js';
import config from './config/index.js';
import redis from './services/redis.js';
import { ensureBucket } from './services/storage.js';
import logger, { logError } from './services/logger.js';
import pool from './services/db.js';
import { initCassandra, closeCassandra } from './services/cassandra.js';
import { initializeQueue, closeQueue, ensureQueueConnection } from './services/queue.js';
import { startOutboxRelay, stopOutboxRelay } from './services/outbox.js';
import { purgeExpiredIdempotencyKeys } from './services/idempotency.js';

const IDEMPOTENCY_PURGE_INTERVAL_MS = 10 * 60 * 1000;
const HTTP_DRAIN_TIMEOUT_MS = 10000;

let server: Server | null = null;
let purgeTimer: NodeJS.Timeout | null = null;
let stopping = false;

// ============================================
// Server Startup
// ============================================

const startServer = async (): Promise<void> => {
  try {
    // Ensure MinIO bucket exists
    await ensureBucket();

    // Initialize Cassandra for DMs (non-blocking - DMs are optional)
    initCassandra().catch((err: Error) => {
      logger.warn({ error: err.message }, 'Cassandra initialization failed - DMs will be unavailable');
    });

    // RabbitMQ is optional at startup: new posts wait in the outbox until the broker is
    // reachable, and the connection keeps retrying in the background.
    initializeQueue().catch((err: Error) => {
      logger.warn({ error: err.message }, 'RabbitMQ unavailable - posts will queue in the outbox until it returns');
      ensureQueueConnection();
    });

    // Start the server
    server = app.listen(config.port, () => {
      logger.info(
        {
          port: config.port,
          env: config.nodeEnv,
          pid: process.pid,
        },
        `Instagram API server running on port ${config.port}`
      );
    });

    // Publish committed outbox events (media jobs) to RabbitMQ
    startOutboxRelay();

    purgeTimer = setInterval(() => {
      purgeExpiredIdempotencyKeys()
        .then((removed) => {
          if (removed > 0) logger.info({ removed }, 'Purged expired idempotency keys');
        })
        .catch((err: Error) => logger.warn({ error: err.message }, 'Idempotency key purge failed'));
    }, IDEMPOTENCY_PURGE_INTERVAL_MS);
    purgeTimer.unref();
  } catch (error) {
    const err = error as Error;
    logError(err, { context: 'startup' });
    process.exit(1);
  }
};

// Graceful shutdown: fail readiness, stop accepting, drain in-flight requests, stop background
// loops, then close dependencies. Closing the pools first (as before) failed requests that
// were still running.
const gracefulShutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, `Received ${signal}, starting graceful shutdown`);
  markShuttingDown();

  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    const timer = setTimeout(resolve, HTTP_DRAIN_TIMEOUT_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  logger.info('HTTP server closed');

  if (purgeTimer) clearInterval(purgeTimer);
  await stopOutboxRelay();

  // Close database pool
  try {
    await pool.end();
    logger.info('Database connections closed');
  } catch (err) {
    logError(err as Error, { context: 'shutdown', component: 'database' });
  }

  // Close Redis connection
  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logError(err as Error, { context: 'shutdown', component: 'redis' });
  }

  // Close Cassandra connection
  try {
    await closeCassandra();
    logger.info('Cassandra connection closed');
  } catch (err) {
    logError(err as Error, { context: 'shutdown', component: 'cassandra' });
  }

  // Close RabbitMQ connection
  await closeQueue();

  process.exit(0);
};

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

startServer();
