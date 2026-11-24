/**
 * @fileoverview Periodic frontier maintenance.
 *
 * Keeps the hybrid Redis + PostgreSQL frontier self-healing without operator
 * intervention:
 *
 * 1. **Lease recovery** - URLs stuck in `in_progress` longer than
 *    `staleLeaseMinutes` (their worker crashed or was killed) go back to
 *    `pending` and back into their Redis priority queue.
 * 2. **Queue rehydration** - if Redis lost queue entries (restart without
 *    persistence, FLUSHALL, manual key deletion), pending rows are re-queued
 *    from Postgres, the source of truth.
 * 3. **Operator settings republish** - domain blocks and crawl-delay
 *    overrides are re-published from Postgres to Redis, so a Redis restart
 *    can't silently unblock a domain an operator blocked.
 * 4. **Stale worker cleanup** - workers whose heartbeat stopped are removed
 *    from the active-workers set so the dashboard is accurate.
 *
 * Runs inside the API server. Several API instances may run; a Redis
 * `SET NX PX` lock ensures only one of them does the work per interval.
 *
 * @module services/maintenance
 */

import { redis, REDIS_KEYS } from '../models/redis.js';
import { frontierService } from './frontier.js';
import { cleanupService } from './cleanup.js';
import * as domainSettings from './domainSettings.js';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';

export interface MaintenanceResult {
  ran: boolean;
  recovered: number;
  rehydrated: number;
  settingsRepublished: number;
  staleWorkers: number;
}

export class MaintenanceService {
  private intervalId: NodeJS.Timeout | null = null;

  /**
   * Runs one maintenance pass if no other instance holds the lock.
   */
  async runOnce(): Promise<MaintenanceResult> {
    const lockTtl = Math.max(5000, config.crawler.maintenanceIntervalMs - 1000);
    const acquired = await redis.set(REDIS_KEYS.MAINTENANCE_LOCK, process.pid.toString(), 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') {
      return { ran: false, recovered: 0, rehydrated: 0, settingsRepublished: 0, staleWorkers: 0 };
    }

    const recovered = await frontierService.recoverStaleUrls(config.crawler.staleLeaseMinutes);
    const rehydrated = await frontierService.rehydrateQueues();
    const settingsRepublished = await domainSettings.republishAll();
    const staleWorkers = await cleanupService.cleanupRedis();

    if (recovered > 0 || rehydrated > 0 || staleWorkers > 0) {
      logger.info({ recovered, rehydrated, staleWorkers }, 'Frontier maintenance repaired state');
    }

    return { ran: true, recovered, rehydrated, settingsRepublished, staleWorkers };
  }

  start(): void {
    if (this.intervalId) return;

    const tick = () => {
      this.runOnce().catch((err) => logger.error({ err }, 'Frontier maintenance failed'));
    };

    tick(); // on startup: picks up anything orphaned while the system was down
    this.intervalId = setInterval(tick, config.crawler.maintenanceIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const maintenanceService = new MaintenanceService();
