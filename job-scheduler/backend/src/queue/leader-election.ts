import { redis } from './redis';
import { logger } from '../utils/logger';

export class LeaderElection {
  private instanceId: string;
  private lockKey: string;
  private lockTTL: number;
  private isLeader: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    instanceId: string,
    lockKey: string = 'job_scheduler:leader',
    lockTTL: number = 30
  ) {
    this.instanceId = instanceId;
    this.lockKey = lockKey;
    this.lockTTL = lockTTL;
  }

  /**
   * Try to become the leader
   */
  async tryBecomeLeader(): Promise<boolean> {
    try {
      const result = await redis.set(
        this.lockKey,
        this.instanceId,
        'EX',
        this.lockTTL,
        'NX'
      );

      this.isLeader = result === 'OK';

      if (this.isLeader) {
        logger.info(`Instance ${this.instanceId} became leader`);
        this.startHeartbeat();
      }

      return this.isLeader;
    } catch (error) {
      logger.error('Error trying to become leader', error);
      this.isLeader = false;
      return false;
    }
  }

  /**
   * Extend leadership lock
   */
  async maintainLeadership(): Promise<boolean> {
    if (!this.isLeader) {
      return false;
    }

    try {
      // Check if we still own the lock
      const currentHolder = await redis.get(this.lockKey);

      if (currentHolder !== this.instanceId) {
        logger.warn(`Lost leadership: lock held by ${currentHolder}`);
        this.isLeader = false;
        this.stopHeartbeat();
        return false;
      }

      // Extend the lock
      await redis.expire(this.lockKey, this.lockTTL);
      return true;
    } catch (error) {
      logger.error('Error maintaining leadership', error);
      this.isLeader = false;
      this.stopHeartbeat();
      return false;
    }
  }

  /**
   * Voluntarily release leadership
   */
  async releaseLeadership(): Promise<void> {
    if (!this.isLeader) {
      return;
    }

    try {
      // Only delete if we own the lock (using Lua script for atomicity)
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      await redis.eval(script, 1, this.lockKey, this.instanceId);
      logger.info(`Instance ${this.instanceId} released leadership`);
    } catch (error) {
      logger.error('Error releasing leadership', error);
    } finally {
      this.isLeader = false;
      this.stopHeartbeat();
    }
  }

  /**
   * Check if this instance is the leader
   */
  getIsLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Get the current leader instance ID
   */
  async getCurrentLeader(): Promise<string | null> {
    return redis.get(this.lockKey);
  }

  /**
   * Start the heartbeat to maintain leadership
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return;
    }

    // Heartbeat at 1/3 of the TTL
    const heartbeatMs = (this.lockTTL * 1000) / 3;
    this.heartbeatInterval = setInterval(async () => {
      const maintained = await this.maintainLeadership();
      if (!maintained) {
        logger.warn('Failed to maintain leadership in heartbeat');
      }
    }, heartbeatMs);

    logger.debug(`Started leadership heartbeat every ${heartbeatMs}ms`);
  }

  /**
   * Stop the heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      logger.debug('Stopped leadership heartbeat');
    }
  }
}

/**
 * Distributed lock for job execution deduplication
 */
export class DistributedLock {
  private lockTTL: number;

  constructor(lockTTL: number = 3600) {
    this.lockTTL = lockTTL;
  }

  /**
   * Try to acquire a lock
   */
  async acquire(key: string, value: string): Promise<boolean> {
    const lockKey = `job_scheduler:lock:${key}`;
    const result = await redis.set(lockKey, value, 'EX', this.lockTTL, 'NX');
    return result === 'OK';
  }

  /**
   * Check if a lock is held
   */
  async isLocked(key: string): Promise<boolean> {
    const lockKey = `job_scheduler:lock:${key}`;
    const exists = await redis.exists(lockKey);
    return exists === 1;
  }

  /**
   * Get the current lock holder
   */
  async getHolder(key: string): Promise<string | null> {
    const lockKey = `job_scheduler:lock:${key}`;
    return redis.get(lockKey);
  }

  /**
   * Release a lock (only if we hold it)
   */
  async release(key: string, value: string): Promise<boolean> {
    const lockKey = `job_scheduler:lock:${key}`;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, lockKey, value);
    return result === 1;
  }

  /**
   * Extend a lock's TTL (only if we hold it)
   */
  async extend(key: string, value: string, ttl?: number): Promise<boolean> {
    const lockKey = `job_scheduler:lock:${key}`;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, lockKey, value, ttl || this.lockTTL);
    return result === 1;
  }
}

export const distributedLock = new DistributedLock();
