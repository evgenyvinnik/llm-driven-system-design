/**
 * Image job handling for the worker.
 *
 * The queue delivers at least once (the outbox may publish twice, RabbitMQ redelivers after a
 * crash, failed jobs come back through the retry queue), so every step is safe to repeat:
 *   1. Skip the image work if the post is gone or already published.
 *   2. Resize into deterministic object keys (images/{postId}/{index}/{size}.jpg): a repeat
 *      overwrites the same objects.
 *   3. Commit media URLs + status in a short transaction that re-checks the status under a row
 *      lock, so two concurrent deliveries can't both publish.
 *   4. After COMMIT: delete originals, drop the cached post, fan out to timelines.
 * Fan-out runs after the commit on purpose: a timeline entry must never point at a post whose
 * media rows were rolled back. Fan-out writes are idempotent (ZADD of the same member and
 * score), so a delivery that finds the post already published re-runs fan-out; that is how a
 * fan-out that failed after the commit gets completed by the retry.
 */
import { query, getClient } from './db.js';
import { processStoredImage, deleteObject } from './storage.js';
import { invalidatePostCache } from './redis.js';
import { fanOutPost, FanoutResult } from './feedService.js';
import logger from './logger.js';
import { imageProcessingDuration, imageProcessingErrors, imageJobOutcomes } from './metrics.js';
import type { ImageProcessingJob, JobDelivery } from './queue.js';

export type ImageJobOutcome = 'published' | 'duplicate' | 'post_missing';

interface ProcessedMedia {
  orderIndex: number;
  originalKey: string;
  mediaUrl: string;
  thumbnailUrl: string;
  width: number | undefined;
  height: number | undefined;
}

interface PostStateRow {
  status: string;
  created_ms: string;
}

const POST_STATE_SQL = `SELECT status, FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ms
                        FROM posts WHERE id = $1`;

async function resizeAll(job: ImageProcessingJob, delivery: JobDelivery): Promise<ProcessedMedia[]> {
  const processed: ProcessedMedia[] = [];
  try {
    for (const item of job.mediaItems) {
      const result = await processStoredImage(
        item.originalKey,
        item.filterName,
        `images/${job.postId}/${item.orderIndex}`
      );
      processed.push({
        orderIndex: item.orderIndex,
        originalKey: item.originalKey,
        mediaUrl: result.mediaUrl,
        thumbnailUrl: result.thumbnailUrl,
        width: result.width,
        height: result.height,
      });
    }
  } catch (error) {
    const err = error as Error;
    imageProcessingErrors.labels(err.name || 'unknown').inc();
    logger.error(
      { type: 'image_processing_error', postId: job.postId, attempt: delivery.attempt, error: err.message },
      `Failed to process images for post ${job.postId}`
    );
    throw error;
  }
  return processed;
}

/**
 * Writes media URLs and flips the post to 'published' under a row lock.
 * Returns the post's created_ms, or the reason nothing was written.
 */
async function commitPublished(
  postId: string,
  processed: ProcessedMedia[]
): Promise<{ createdMs: number } | { skipped: 'duplicate' | 'post_missing' }> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const locked = await client.query<PostStateRow>(`${POST_STATE_SQL} FOR UPDATE`, [postId]);
    if (locked.rows.length === 0 || locked.rows[0].status === 'published') {
      await client.query('ROLLBACK');
      return { skipped: locked.rows.length === 0 ? 'post_missing' : 'duplicate' };
    }
    for (const media of processed) {
      await client.query(
        `UPDATE post_media
         SET media_url = $1, thumbnail_url = $2, width = $3, height = $4, processed_at = NOW()
         WHERE post_id = $5 AND order_index = $6`,
        [media.mediaUrl, media.thumbnailUrl, media.width, media.height, postId, media.orderIndex]
      );
    }
    await client.query(`UPDATE posts SET status = 'published' WHERE id = $1`, [postId]);
    await client.query('COMMIT');
    return { createdMs: Number(locked.rows[0].created_ms) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processImageJob(job: ImageProcessingJob, delivery: JobDelivery): Promise<ImageJobOutcome> {
  const { postId, userId, mediaItems } = job;
  const startTime = Date.now();

  const current = await query<PostStateRow>(POST_STATE_SQL, [postId]);
  if (current.rows.length === 0) {
    imageJobOutcomes.labels('post_missing').inc();
    logger.info({ type: 'image_job_skipped', postId, reason: 'post_missing' }, 'Post deleted before processing');
    return 'post_missing';
  }
  if (current.rows[0].status === 'published') {
    // Duplicate delivery: no image work, but make sure fan-out happened (idempotent).
    await fanOutPost(userId, postId, Number(current.rows[0].created_ms));
    imageJobOutcomes.labels('duplicate').inc();
    logger.info({ type: 'image_job_skipped', postId, reason: 'already_published' }, 'Duplicate image job: fan-out re-checked');
    return 'duplicate';
  }

  const processed = await resizeAll(job, delivery);
  const committed = await commitPublished(postId, processed);
  if ('skipped' in committed) {
    imageJobOutcomes.labels(committed.skipped).inc();
    return committed.skipped;
  }

  // The post is durably published; the rest is cleanup and derived state.
  await Promise.all(processed.map((media) => deleteObject(media.originalKey)));
  await invalidatePostCache(postId).catch(() => undefined);

  let fanout: FanoutResult;
  try {
    fanout = await fanOutPost(userId, postId, committed.createdMs);
  } catch (error) {
    // Failing the job sends it through the retry queue; the next delivery takes the
    // 'already published' branch above and completes the fan-out without redoing image work.
    logger.error({ type: 'fanout_error', postId, error: (error as Error).message }, 'Fan-out failed after publish');
    throw error;
  }

  const duration = (Date.now() - startTime) / 1000;
  imageProcessingDuration.labels('all').observe(duration);
  imageJobOutcomes.labels('published').inc();
  logger.info(
    {
      type: 'post_published',
      postId,
      userId,
      attempt: delivery.attempt,
      mediaCount: mediaItems.length,
      fanoutMode: fanout.mode,
      timelinesWritten: fanout.timelinesWritten,
      durationSeconds: duration,
    },
    `Post ${postId} published after processing`
  );
  return 'published';
}

/** Dead-letter hook: the job used up its attempts, so the author sees the upload as failed. */
export async function markPostFailed(job: ImageProcessingJob, error: Error): Promise<void> {
  await query(`UPDATE posts SET status = 'failed' WHERE id = $1 AND status = 'processing'`, [job.postId]);
  await invalidatePostCache(job.postId).catch(() => undefined);
  logger.error(
    { type: 'image_job_dead_lettered', postId: job.postId, error: error.message },
    `Post ${job.postId} marked failed after exhausting retries`
  );
}
