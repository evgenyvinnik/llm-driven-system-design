import { app } from './app.js';
import { config } from './config/index.js';
import { logger } from './services/logger.js';
import { connectRedis, redis } from './services/redis.js';
import { pool } from './services/db.js';
import { initPubSub, closePubSub } from './services/pubsub.js';
import {
  closeAllStreams,
  deliverChannelEvent,
  startHeadChecks,
  stopHeadChecks,
} from './services/sseService.js';
import { ensureBucket } from './services/storageService.js';

async function start() {
  try {
    // Connect to Redis
    await connectRedis();

    // Test database connection
    await pool.query('SELECT 1');
    logger.info('Database connected');

    // Every event any instance publishes (this one included) is offered to the local SSE streams,
    // which drop copies and fill gaps by sequence number.
    await initPubSub(deliverChannelEvent);
    startHeadChecks();

    // Ensure MinIO bucket exists
    await ensureBucket();

    const server = app.listen(config.port, () => {
      logger.info({ port: config.port }, 'Microsoft Teams backend server started');
    });

    // Graceful shutdown. SSE responses never finish on their own, so server.close() would wait
    // forever; ending them sends every client to another instance, where it resumes from its
    // Last-Event-ID without losing anything.
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutting down gracefully');
      server.close(async () => {
        await closePubSub().catch(() => {});
        await redis.quit().catch(() => {});
        await pool.end().catch(() => {});
        logger.info('Server shut down');
        process.exit(0);
      });
      stopHeadChecks();
      closeAllStreams();
      server.closeIdleConnections();
      setTimeout(() => {
        logger.warn('Forcing exit after shutdown timeout');
        process.exit(1);
      }, 10_000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
