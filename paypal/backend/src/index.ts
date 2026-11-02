import { app } from './app.js';
import { config } from './config/index.js';
import { logger } from './services/logger.js';
import { connectRedis } from './services/redis.js';
import { pool } from './services/db.js';
import { cleanExpiredIdempotencyKeys } from './services/idempotencyService.js';

/** How often expired idempotency keys are purged (they live 24 hours). */
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function start() {
  try {
    // Connect to Redis
    await connectRedis();

    // Test database connection
    await pool.query('SELECT 1');
    logger.info('Database connected');

    const server = app.listen(config.port, () => {
      logger.info({ port: config.port }, 'PayPal backend server started');
    });

    // Keep the idempotency table bounded. Every instance runs this; the DELETE
    // is idempotent, so overlapping runs are harmless.
    const cleanup = () =>
      cleanExpiredIdempotencyKeys().catch((err) =>
        logger.warn({ err }, 'Idempotency key cleanup failed'),
      );
    void cleanup();
    const cleanupTimer = setInterval(cleanup, IDEMPOTENCY_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down gracefully');
      clearInterval(cleanupTimer);
      server.close(async () => {
        await pool.end();
        logger.info('Server shut down');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
