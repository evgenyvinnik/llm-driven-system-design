import { app } from './app.js';
import { config } from './config/index.js';
import { logger } from './services/logger.js';
import { connectRedis } from './services/redis.js';
import { pool } from './services/db.js';
import { initPubSub, closePubSub } from './services/pubsub.js';
import { ensureBucket } from './services/storageService.js';
import { closeAllClients } from './services/sseService.js';

async function start() {
  try {
    // Connect to Redis
    await connectRedis();

    // Test database connection
    await pool.query('SELECT 1');
    logger.info('Database connected');

    // Initialize pub/sub for cross-instance messaging
    await initPubSub();

    // Ensure MinIO bucket exists
    await ensureBucket();

    const server = app.listen(config.port, () => {
      logger.info({ port: config.port }, 'Microsoft Teams backend server started');
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down gracefully');
      // Drain SSE streams first, or server.close() never completes.
      closeAllClients();
      server.close(async () => {
        await closePubSub();
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
