/**
 * Image processing worker.
 * Consumes jobs from RabbitMQ and processes images asynchronously.
 *
 * Flow (see services/mediaPipeline.ts for the idempotency rules):
 * 1. Consume job from queue (published by the API's outbox relay)
 * 2. Fetch original image from MinIO and resize it into deterministic keys
 * 3. Commit processed URLs and status 'published' in one short transaction
 * 4. Delete originals, invalidate the cached post, fan out to follower timelines
 *
 * Failures go to the retry queue (5 s delay) up to MEDIA_JOB_MAX_ATTEMPTS, then to the
 * dead-letter queue with the post marked 'failed'.
 */
import { consumeImageProcessingJobs, initializeQueue, closeQueue } from '../services/queue.js';
import { ensureBucket } from '../services/storage.js';
import { processImageJob, markPostFailed } from '../services/mediaPipeline.js';
import pool from '../services/db.js';
import redis from '../services/redis.js';
import config from '../config/index.js';
import logger from '../services/logger.js';

const RETRY_STARTUP_MS = 5000;

/**
 * Main worker entry point.
 */
async function main(): Promise<void> {
  logger.info('Starting image processing worker');

  // Ensure MinIO bucket exists
  await ensureBucket();

  // Wait for the broker: on a fresh `docker-compose up` the worker often starts first.
  for (;;) {
    try {
      await initializeQueue();
      break;
    } catch {
      logger.warn({ retryInMs: RETRY_STARTUP_MS }, 'RabbitMQ not reachable yet');
      await new Promise((resolve) => setTimeout(resolve, RETRY_STARTUP_MS));
    }
  }

  // Start consuming jobs (the registration survives reconnects)
  await consumeImageProcessingJobs(processImageJob, {
    maxAttempts: config.mediaPipeline.maxAttempts,
    onDeadLetter: markPostFailed,
  });

  logger.info({ maxAttempts: config.mediaPipeline.maxAttempts }, 'Image worker ready and consuming jobs');

  // Graceful shutdown: stop taking jobs, let the current one finish, then close connections.
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down worker');
    await closeQueue();
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: Error) => {
  logger.error({ error: error.message }, 'Worker failed to start');
  process.exit(1);
});
