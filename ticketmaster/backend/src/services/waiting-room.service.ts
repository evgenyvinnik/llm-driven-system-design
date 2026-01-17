import redis from '../db/redis.js';
import type { QueueStatus } from '../types/index.js';

const ACTIVE_SESSION_TTL = 900; // 15 minutes active shopping time
const QUEUE_PROCESS_INTERVAL = 1000; // Process queue every second

export class WaitingRoomService {
  private processingIntervals: Map<string, NodeJS.Timeout> = new Map();

  async joinQueue(eventId: string, sessionId: string): Promise<QueueStatus> {
    const queueKey = `queue:${eventId}`;
    const activeKey = `active:${eventId}`;

    // Check if already active
    const isActive = await redis.sismember(activeKey, sessionId);
    if (isActive) {
      return {
        position: 0,
        status: 'active',
        estimated_wait_seconds: 0,
      };
    }

    // Check if already in queue
    const existingRank = await redis.zrank(queueKey, sessionId);
    if (existingRank !== null) {
      const position = existingRank + 1;
      return {
        position,
        status: 'waiting',
        estimated_wait_seconds: this.estimateWait(position),
      };
    }

    // Add to queue with current timestamp + small random jitter for fairness
    const timestamp = Date.now() + Math.random() * 100;
    await redis.zadd(queueKey, timestamp, sessionId);

    const rank = await redis.zrank(queueKey, sessionId);
    const position = (rank || 0) + 1;

    return {
      position,
      status: 'waiting',
      estimated_wait_seconds: this.estimateWait(position),
    };
  }

  async getQueueStatus(eventId: string, sessionId: string): Promise<QueueStatus> {
    const queueKey = `queue:${eventId}`;
    const activeKey = `active:${eventId}`;

    // Check if active
    const isActive = await redis.sismember(activeKey, sessionId);
    if (isActive) {
      return {
        position: 0,
        status: 'active',
        estimated_wait_seconds: 0,
      };
    }

    // Check queue position
    const rank = await redis.zrank(queueKey, sessionId);
    if (rank === null) {
      return {
        position: 0,
        status: 'not_in_queue',
        estimated_wait_seconds: 0,
      };
    }

    const position = rank + 1;
    return {
      position,
      status: 'waiting',
      estimated_wait_seconds: this.estimateWait(position),
    };
  }

  async isSessionActive(eventId: string, sessionId: string): Promise<boolean> {
    const activeSessionKey = `active_session:${eventId}:${sessionId}`;
    const exists = await redis.exists(activeSessionKey);
    return exists === 1;
  }

  async admitNextBatch(eventId: string, maxConcurrent: number): Promise<number> {
    const queueKey = `queue:${eventId}`;
    const activeKey = `active:${eventId}`;

    // Count current active users
    const activeCount = await redis.scard(activeKey);
    const slotsAvailable = maxConcurrent - activeCount;

    if (slotsAvailable <= 0) {
      return 0;
    }

    // Get next batch from queue
    const nextUsers = await redis.zrange(queueKey, 0, slotsAvailable - 1);

    if (nextUsers.length === 0) {
      return 0;
    }

    // Move to active set
    const pipeline = redis.pipeline();
    for (const sessionId of nextUsers) {
      pipeline.sadd(activeKey, sessionId);
      pipeline.setex(`active_session:${eventId}:${sessionId}`, ACTIVE_SESSION_TTL, '1');
    }
    pipeline.zrem(queueKey, ...nextUsers);
    await pipeline.exec();

    return nextUsers.length;
  }

  async leaveQueue(eventId: string, sessionId: string): Promise<void> {
    const queueKey = `queue:${eventId}`;
    const activeKey = `active:${eventId}`;

    await redis.zrem(queueKey, sessionId);
    await redis.srem(activeKey, sessionId);
    await redis.del(`active_session:${eventId}:${sessionId}`);
  }

  async getQueueStats(eventId: string): Promise<{
    queueLength: number;
    activeCount: number;
    estimatedWait: number;
  }> {
    const queueKey = `queue:${eventId}`;
    const activeKey = `active:${eventId}`;

    const [queueLength, activeCount] = await Promise.all([
      redis.zcard(queueKey),
      redis.scard(activeKey),
    ]);

    return {
      queueLength,
      activeCount,
      estimatedWait: this.estimateWait(queueLength),
    };
  }

  startQueueProcessor(eventId: string, maxConcurrent: number): void {
    if (this.processingIntervals.has(eventId)) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const admitted = await this.admitNextBatch(eventId, maxConcurrent);
        if (admitted > 0) {
          console.log(`Admitted ${admitted} users for event ${eventId}`);
        }
      } catch (error) {
        console.error(`Error processing queue for event ${eventId}:`, error);
      }
    }, QUEUE_PROCESS_INTERVAL);

    this.processingIntervals.set(eventId, interval);
    console.log(`Started queue processor for event ${eventId}`);
  }

  stopQueueProcessor(eventId: string): void {
    const interval = this.processingIntervals.get(eventId);
    if (interval) {
      clearInterval(interval);
      this.processingIntervals.delete(eventId);
      console.log(`Stopped queue processor for event ${eventId}`);
    }
  }

  private estimateWait(position: number): number {
    // Rough estimate: ~10 users per second can be admitted
    // and average shopping time is about 5 minutes
    const usersPerSecond = 10;
    return Math.ceil(position / usersPerSecond);
  }
}

export const waitingRoomService = new WaitingRoomService();
