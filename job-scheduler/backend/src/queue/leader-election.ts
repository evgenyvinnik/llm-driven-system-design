/**
 * Leader election for the scheduler tick, implemented as a lease in Redis.
 *
 * Only the leader fires due jobs and reaps expired execution leases. The lease is an
 * efficiency mechanism, not the correctness guarantee: firing is an idempotent
 * PostgreSQL transaction (see fireDueJobs), so two schedulers that briefly both believe
 * they lead cannot double-fire a slot. What the lease buys is that followers stay idle
 * instead of contending for the same rows every second.
 * @module queue/leader-election
 */

import { performance } from 'perf_hooks';
import { redis } from './redis';
import { logger } from '../utils/logger';

/** Extends the lease only if this instance still holds it (atomic compare-and-pexpire). */
const RENEW_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

/** Deletes the lease only if this instance still holds it (atomic compare-and-delete). */
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/** Optional knobs, mainly for tests. */
export interface LeaderElectionOptions {
  /** Monotonic clock in milliseconds (defaults to performance.now). */
  now?: () => number;
  /** Subtracted from the TTL when computing the local deadline. */
  safetyMarginMs?: number;
}

/**
 * Single-leader lease with heartbeat renewal and local self-fencing.
 *
 * The local deadline is the important part. A leader whose process stalls (GC pause,
 * blocked event loop, network partition from Redis) can't know that its key expired
 * and another instance took over. So it keeps its own deadline, measured from when
 * the last successful SET/renew was *sent* (an underestimate of when Redis applied
 * it), and stops acting as leader the moment that deadline passes, renewed or not.
 */
export class LeaderElection {
  private leader = false;
  /** Local monotonic time after which this instance must not act as leader. */
  private validUntil = 0;
  private renewTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly safetyMarginMs: number;

  /**
   * @param instanceId - unique id of this scheduler process (the lock value)
   * @param lockKey - Redis key holding the lease
   * @param ttlMs - lease length; renewed every ttlMs / 3 while leading
   */
  constructor(
    private readonly instanceId: string,
    private readonly lockKey: string,
    private readonly ttlMs: number,
    options: LeaderElectionOptions = {}
  ) {
    this.now = options.now ?? (() => performance.now());
    this.safetyMarginMs = options.safetyMarginMs ?? Math.min(2000, Math.floor(ttlMs / 10));
  }

  /** True only while the lease is held and its local deadline has not passed. */
  isLeader(): boolean {
    if (this.leader && this.now() >= this.validUntil) {
      logger.warn(
        { instanceId: this.instanceId },
        'Leader lease deadline passed without a successful renewal; stepping down'
      );
      this.stepDown();
    }
    return this.leader;
  }

  /** Tries to take the lease (SET NX PX). Returns true if this instance now leads. */
  async tryAcquire(): Promise<boolean> {
    if (this.isLeader()) {
      return true;
    }

    const sentAt = this.now();
    try {
      const result = await redis.set(this.lockKey, this.instanceId, 'PX', this.ttlMs, 'NX');
      if (result === 'OK') {
        this.becomeLeader(sentAt);
        logger.info({ instanceId: this.instanceId }, 'Acquired scheduler leadership');
        return true;
      }
      return false;
    } catch (error) {
      logger.error({ err: error, instanceId: this.instanceId }, 'Error trying to acquire leadership');
      return false;
    }
  }

  /**
   * Extends the lease if this instance still holds it. Steps down immediately when the
   * key is gone or owned by someone else. On a Redis error it keeps leading only until
   * the local deadline, because the lease may still be valid.
   */
  async renew(): Promise<boolean> {
    if (!this.leader) {
      return false;
    }

    const sentAt = this.now();
    try {
      const result = await redis.eval(RENEW_SCRIPT, 1, this.lockKey, this.instanceId, this.ttlMs);
      if (result === 1) {
        this.validUntil = sentAt + this.ttlMs - this.safetyMarginMs;
        return true;
      }
      logger.warn({ instanceId: this.instanceId }, 'Lost leadership: lease is gone or held by another instance');
      this.stepDown();
      return false;
    } catch (error) {
      logger.error({ err: error, instanceId: this.instanceId }, 'Error renewing leadership');
      return this.isLeader();
    }
  }

  /** Gives up the lease (compare-and-delete), e.g. on graceful shutdown. */
  async release(): Promise<void> {
    const wasLeader = this.leader;
    this.stepDown();
    if (!wasLeader) {
      return;
    }

    try {
      await redis.eval(RELEASE_SCRIPT, 1, this.lockKey, this.instanceId);
      logger.info({ instanceId: this.instanceId }, 'Released scheduler leadership');
    } catch (error) {
      logger.error({ err: error, instanceId: this.instanceId }, 'Error releasing leadership');
    }
  }

  /** Returns the instance id currently holding the lease, if any. */
  async getCurrentLeader(): Promise<string | null> {
    return redis.get(this.lockKey);
  }

  private becomeLeader(sentAt: number): void {
    this.leader = true;
    this.validUntil = sentAt + this.ttlMs - this.safetyMarginMs;
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        void this.renew();
      }, Math.floor(this.ttlMs / 3));
    }
  }

  private stepDown(): void {
    this.leader = false;
    this.validUntil = 0;
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }
}
