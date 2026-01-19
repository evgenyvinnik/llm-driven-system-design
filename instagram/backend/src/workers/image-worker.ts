/**
 * Image processing worker.
 * Consumes jobs from RabbitMQ and processes images asynchronously.
 *
 * Flow:
 * 1. Consume job from queue
 * 2. Fetch original image from MinIO
 * 3. Process image (resize, apply filter)
 * 4. Upload processed versions to MinIO
 * 5. Update database with processed URLs and status
 */
import { consumeImageProcessingJobs, initializeQueue, closeQueue } from '../services/queue.js';
import { processStoredImage, deleteObject, ensureBucket } from '../services/storage.js';
import { query, getClient } from '../services/db.js';
import { timelineAdd } from '../services/redis.js';
import logger from '../services/logger.js';
import {
  imageProcessingDuration,
  imageProcessingErrors,
} from '../services/metrics.js';

/**
 * Process a single image processing job.
 */
async function processImageJob(job) {
  const { postId, userId, mediaItems } = job;
  const startTime = Date.now();
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Process each media item
    for (const item of mediaItems) {
      const { originalKey, filterName, orderIndex } = item;

      logger.info({
        type: 'image_processing_start',
        postId,
        orderIndex,
        originalKey,
      }, `Processing image ${orderIndex} for post ${postId}`);

      // Process the image
      const result = await processStoredImage(originalKey, filterName);

      // Update media record with processed URLs
      await client.query(
        `UPDATE post_media
         SET media_url = $1,
             thumbnail_url = $2,
             width = $3,
             height = $4,
             processed_at = NOW()
         WHERE post_id = $5 AND order_index = $6`,
        [result.mediaUrl, result.thumbnailUrl, result.width, result.height, postId, orderIndex]
      );

      // Delete original after processing
      await deleteObject(originalKey);

      logger.info({
        type: 'image_processing_complete',
        postId,
        orderIndex,
        width: result.width,
        height: result.height,
      }, `Processed image ${orderIndex} for post ${postId}`);
    }

    // Update post status to published
    await client.query(
      `UPDATE posts SET status = 'published', updated_at = NOW() WHERE id = $1`,
      [postId]
    );

    await client.query('COMMIT');

    // Fan out to followers' timelines
    const post = await query('SELECT created_at FROM posts WHERE id = $1', [postId]);
    if (post.rows.length > 0) {
      const timestamp = new Date(post.rows[0].created_at).getTime();

      const followers = await query(
        'SELECT follower_id FROM follows WHERE following_id = $1',
        [userId]
      );

      for (const follower of followers.rows) {
        await timelineAdd(follower.follower_id, postId, timestamp);
      }
      // Add to own timeline too
      await timelineAdd(userId, postId, timestamp);
    }

    const duration = (Date.now() - startTime) / 1000;
    imageProcessingDuration.labels('all').observe(duration);

    logger.info({
      type: 'post_published',
      postId,
      userId,
      mediaCount: mediaItems.length,
      durationSeconds: duration,
    }, `Post ${postId} published after processing`);
  } catch (error) {
    await client.query('ROLLBACK');

    // Update post status to failed
    await query(
      `UPDATE posts SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [postId]
    );

    imageProcessingErrors.labels(error.name || 'unknown').inc();

    logger.error({
      type: 'image_processing_error',
      postId,
      error: error.message,
    }, `Failed to process images for post ${postId}`);

    throw error;
  } finally {
    client.release();
  }
}

/**
 * Main worker entry point.
 */
async function main() {
  logger.info('Starting image processing worker');

  // Ensure MinIO bucket exists
  await ensureBucket();

  // Initialize queue connection
  await initializeQueue();

  // Start consuming jobs
  await consumeImageProcessingJobs(processImageJob);

  logger.info('Image worker ready and consuming jobs');

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down worker');
    await closeQueue();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ error: error.message }, 'Worker failed to start');
  process.exit(1);
});
