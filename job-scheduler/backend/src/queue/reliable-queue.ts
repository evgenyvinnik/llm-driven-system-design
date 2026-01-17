import { redis } from './redis';
import { logger } from '../utils/logger';
import { QueueItem } from '../types';

const QUEUE_KEY = 'job_scheduler:queue';
const PROCESSING_KEY = 'job_scheduler:processing';
const DEAD_LETTER_KEY = 'job_scheduler:dead_letter';

export class ReliableQueue {
  private visibilityTimeoutMs: number;

  constructor(visibilityTimeoutMs: number = 300000) {
    this.visibilityTimeoutMs = visibilityTimeoutMs;
  }

  /**
   * Enqueue a job execution for processing
   * Uses priority as the score (higher priority = lower score for ZPOPMIN to work correctly)
   */
  async enqueue(
    executionId: string,
    jobId: string,
    priority: number = 50
  ): Promise<void> {
    // Invert priority so higher priority jobs come first with ZPOPMIN
    const score = Date.now() - priority * 1000000;
    const item: QueueItem = {
      execution_id: executionId,
      job_id: jobId,
      priority,
      enqueued_at: Date.now(),
    };

    await redis.zadd(QUEUE_KEY, score, JSON.stringify(item));
    logger.debug(`Enqueued execution ${executionId} with priority ${priority}`);
  }

  /**
   * Dequeue the highest priority job
   * Moves it to processing set with visibility timeout
   */
  async dequeue(workerId: string): Promise<QueueItem | null> {
    // Atomically pop from queue
    const result = await redis.zpopmin(QUEUE_KEY);

    if (!result || result.length === 0) {
      return null;
    }

    const itemJson = result[0];
    const item: QueueItem = JSON.parse(itemJson);

    // Add to processing set with timeout
    const timeout = Date.now() + this.visibilityTimeoutMs;
    const processingKey = `${item.execution_id}:${workerId}`;
    await redis.zadd(PROCESSING_KEY, timeout, processingKey);

    logger.debug(`Dequeued execution ${item.execution_id} for worker ${workerId}`);
    return item;
  }

  /**
   * Mark a job as completed and remove from processing
   */
  async complete(executionId: string, workerId: string): Promise<void> {
    const processingKey = `${executionId}:${workerId}`;
    await redis.zrem(PROCESSING_KEY, processingKey);
    logger.debug(`Completed execution ${executionId}`);
  }

  /**
   * Re-enqueue a failed job for retry
   */
  async requeue(
    executionId: string,
    jobId: string,
    workerId: string,
    priority: number = 50
  ): Promise<void> {
    const processingKey = `${executionId}:${workerId}`;
    await redis.zrem(PROCESSING_KEY, processingKey);
    await this.enqueue(executionId, jobId, priority);
    logger.debug(`Requeued execution ${executionId}`);
  }

  /**
   * Move a job to the dead letter queue
   */
  async sendToDeadLetter(
    executionId: string,
    workerId: string,
    error: string
  ): Promise<void> {
    const processingKey = `${executionId}:${workerId}`;
    await redis.zrem(PROCESSING_KEY, processingKey);

    const deadLetterItem = {
      execution_id: executionId,
      worker_id: workerId,
      error,
      failed_at: Date.now(),
    };
    await redis.lpush(DEAD_LETTER_KEY, JSON.stringify(deadLetterItem));
    logger.warn(`Sent execution ${executionId} to dead letter queue`);
  }

  /**
   * Recover stalled jobs that have exceeded their visibility timeout
   */
  async recoverStalled(): Promise<string[]> {
    const now = Date.now();
    const stalled = await redis.zrangebyscore(PROCESSING_KEY, '-inf', now);

    const recovered: string[] = [];
    for (const item of stalled) {
      const [executionId] = item.split(':');
      // Remove from processing and log
      await redis.zrem(PROCESSING_KEY, item);
      recovered.push(executionId);
      logger.warn(`Recovered stalled execution ${executionId}`);
    }

    return recovered;
  }

  /**
   * Get current queue depth
   */
  async getQueueDepth(): Promise<number> {
    return redis.zcard(QUEUE_KEY);
  }

  /**
   * Get count of jobs currently being processed
   */
  async getProcessingCount(): Promise<number> {
    return redis.zcard(PROCESSING_KEY);
  }

  /**
   * Get dead letter queue size
   */
  async getDeadLetterCount(): Promise<number> {
    return redis.llen(DEAD_LETTER_KEY);
  }

  /**
   * Get items from dead letter queue
   */
  async getDeadLetterItems(start: number = 0, end: number = 100): Promise<unknown[]> {
    const items = await redis.lrange(DEAD_LETTER_KEY, start, end);
    return items.map((item) => JSON.parse(item));
  }

  /**
   * Clear the entire queue (use with caution)
   */
  async clear(): Promise<void> {
    await redis.del(QUEUE_KEY);
    await redis.del(PROCESSING_KEY);
    logger.warn('Queue cleared');
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    queued: number;
    processing: number;
    deadLetter: number;
  }> {
    const [queued, processing, deadLetter] = await Promise.all([
      this.getQueueDepth(),
      this.getProcessingCount(),
      this.getDeadLetterCount(),
    ]);

    return { queued, processing, deadLetter };
  }
}

// Default queue instance
export const queue = new ReliableQueue(
  parseInt(process.env.VISIBILITY_TIMEOUT_MS || '300000', 10)
);
