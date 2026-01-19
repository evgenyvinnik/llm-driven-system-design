import { query } from '../utils/db.js';
import { cacheSet, cacheGet } from '../utils/redis.js';
import { publishTranscodeJob, getQueueStats } from '../shared/queue.js';
import config from '../config/index.js';
import logger from '../shared/logger.js';
import { transcodeQueueDepth } from '../shared/metrics.js';

/**
 * Queue a transcoding job via RabbitMQ
 */
export const queueTranscodingJob = async (videoId, sourceKey, userId) => {
  // Publish to RabbitMQ queue
  await publishTranscodeJob(videoId, sourceKey, userId);

  const job = {
    videoId,
    sourceKey,
    userId,
    createdAt: new Date().toISOString(),
    status: 'queued',
  };

  // Cache job status for quick lookups
  await cacheSet(`transcode:${videoId}`, job, 3600);

  // Update queue depth metric (async, don't await)
  getQueueStats().then(stats => {
    if (stats) {
      transcodeQueueDepth.set(stats.messageCount);
    }
  }).catch(() => {});

  logger.info({
    event: 'transcode_job_queued',
    videoId,
    userId,
  }, `Transcoding job queued for video ${videoId}`);

  return job;
};

/**
 * Get transcoding status
 */
export const getTranscodingStatus = async (videoId) => {
  const cached = await cacheGet(`transcode:${videoId}`);
  if (cached) {
    return cached;
  }

  // Check database if not in cache
  const result = await query(
    'SELECT status FROM videos WHERE id = $1',
    [videoId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    videoId,
    status: result.rows[0].status,
  };
};

/**
 * Get queue status for admin dashboard
 */
export const getQueueStatus = async () => {
  const stats = await getQueueStats();
  return {
    queueLength: stats?.messageCount || 0,
    consumerCount: stats?.consumerCount || 0,
    queue: stats?.queue || config.rabbitmq.queues.transcode,
  };
};
