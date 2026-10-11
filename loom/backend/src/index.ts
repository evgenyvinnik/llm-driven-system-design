import { app } from './app.js';
import { config } from './config/index.js';
import { logger } from './services/logger.js';
import { connectRedis, redis } from './services/redis.js';
import { pool } from './services/db.js';
import { ensureBucket } from './services/storageService.js';
import { sweepStaleUploads } from './services/uploadService.js';
import { uploadsSwept } from './services/metrics.js';

/**
 * Periodically fails uploads nobody is feeding and aborts their multipart uploads.
 * Safe to run in every API instance: claims use FOR UPDATE SKIP LOCKED.
 */
function startUploadSweeper(): NodeJS.Timeout | null {
  if (config.upload.sweepIntervalMs <= 0) return null;
  const timer = setInterval(async () => {
    try {
      const { swept, aborted } = await sweepStaleUploads();
      if (swept > 0) {
        uploadsSwept.inc(swept);
        logger.info({ swept, aborted }, 'Swept abandoned uploads');
      }
    } catch (err) {
      logger.error({ err }, 'Upload sweep failed');
    }
  }, config.upload.sweepIntervalMs);
  timer.unref();
  return timer;
}

async function start() {
  try {
    // Connect to Redis
    await connectRedis();

    // Test database connection
    await pool.query('SELECT 1');
    logger.info('Database connected');

    // Ensure MinIO bucket exists
    await ensureBucket();
    logger.info('MinIO storage ready');

    const server = app.listen(config.port, () => {
      logger.info({ port: config.port }, 'Loom backend server started');
    });
    const sweeper = startUploadSweeper();

    // Graceful shutdown: stop accepting, let in-flight requests finish, then close clients.
    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutting down gracefully');
      if (sweeper) clearInterval(sweeper);
      const force = setTimeout(() => {
        logger.warn('Forcing exit after shutdown timeout');
        process.exit(1);
      }, 10000);
      force.unref();
      server.close(async () => {
        await pool.end().catch(() => undefined);
        await redis.quit().catch(() => undefined);
        logger.info('Server shut down');
        process.exit(0);
      });
      server.closeIdleConnections();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
