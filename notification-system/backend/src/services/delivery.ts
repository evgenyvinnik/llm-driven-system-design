import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../utils/database.js';
import { redis } from '../utils/redis.js';
import { enqueueDeliveries, PRIORITY_RANK } from './outbox.js';

/**
 * Content-based duplicate suppression: the same template + data for the same
 * user inside the window is sent once. The key is claimed with SET NX, so two
 * concurrent identical requests cannot both pass (the old GET-then-SETEX could),
 * and it is a SHA-256 of the content scoped by user instead of a 32-bit hash
 * that could make two different users' notifications collide.
 */
export class DeduplicationService {
  generateKey(userId: string, templateId: string | undefined, data: Record<string, unknown>): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({ templateId: templateId ?? null, data }))
      .digest('hex');
    return `dedup:${userId}:${digest}`;
  }

  /** True when this request claimed the content key; false when it is a duplicate. */
  async claim(key: string, windowSeconds: number = 60): Promise<boolean> {
    const result = await redis.set(key, '1', 'EX', Math.max(1, Math.floor(windowSeconds)), 'NX');
    return result === 'OK';
  }

  /** Gives the key back when the request did not end up creating a notification. */
  async release(key: string): Promise<void> {
    await redis.del(key).catch(() => undefined);
  }
}

export interface DeliveryStatusResult {
  notificationId: string;
  channel: string;
  status: string;
}

interface DeliveryStatsRow {
  channel: string;
  status: string;
  count: string;
}

export interface NotificationWithDeliveryStatus {
  id: string;
  user_id: string;
  template_id: string | null;
  content: Record<string, unknown>;
  channels: string[];
  priority: string;
  status: string;
  scheduled_at: Date | null;
  created_at: Date;
  delivered_at: Date | null;
  delivery_statuses: unknown[];
}

export type DeliveryStats = Record<string, Record<string, number>>;

/** A delivery this worker has claimed; `attempt` is also its fencing token. */
export interface ClaimedDelivery {
  notificationId: string;
  channel: string;
  userId: string;
  priority: string;
  content: Record<string, unknown>;
  attempt: number;
}

const SUCCESS_STATUSES = new Set(['sent', 'delivered']);

/**
 * Overall notification status from its per-channel delivery statuses.
 * Cancelled channels are ignored unless every channel was cancelled.
 */
export function aggregateStatus(statuses: string[]): string | null {
  if (statuses.length === 0) return null;
  const relevant = statuses.filter((status) => status !== 'cancelled');
  if (relevant.length === 0) return 'cancelled';

  const sent = relevant.filter((status) => SUCCESS_STATUSES.has(status)).length;
  const failed = relevant.filter((status) => status === 'failed').length;
  const active = relevant.length - sent - failed;

  if (active > 0) return sent + failed > 0 ? 'partial' : 'pending';
  if (sent === relevant.length) return 'delivered';
  if (failed === relevant.length) return 'failed';
  return 'partial_success';
}

/** Tracks the per-channel delivery state machine and the notification's aggregate status. */
export class DeliveryTracker {
  /** One 'pending' row per channel, written in the same transaction as the notification. */
  async createDeliveries(
    client: PoolClient,
    notificationId: string,
    channels: string[],
    notBefore: Date | null = null
  ): Promise<void> {
    for (const channel of channels) {
      await client.query(
        `INSERT INTO delivery_status (notification_id, channel, status, attempts, next_retry_at, updated_at)
         VALUES ($1, $2, 'pending', 0, $3, NOW())
         ON CONFLICT (notification_id, channel) DO NOTHING`,
        [notificationId, channel, notBefore]
      );
    }
  }

  /**
   * Claims a delivery for this worker. Only rows that still need work qualify:
   * pending or retrying, or 'sending' with an expired lease because the
   * previous worker died. Returns null for anything else — already sent,
   * failed, cancelled, held by a live lease — which makes redelivered and
   * duplicate messages harmless. Timing is not re-checked here: the relay only
   * publishes rows that are due, and refusing an early duplicate would drop
   * the only message for that delivery.
   */
  async claim(notificationId: string, channel: string, leaseSeconds: number = 60): Promise<ClaimedDelivery | null> {
    const result = await query<{ attempts: number; user_id: string; priority: string; content: Record<string, unknown> }>(
      `UPDATE delivery_status ds
       SET status = 'sending',
           attempts = ds.attempts + 1,
           lease_expires_at = NOW() + make_interval(secs => $3),
           next_retry_at = NULL,
           updated_at = NOW()
       FROM notifications n
       WHERE ds.notification_id = $1
         AND ds.channel = $2
         AND n.id = ds.notification_id
         AND n.status <> 'cancelled'
         AND (
           ds.status IN ('pending', 'retrying')
           OR (ds.status = 'sending' AND ds.lease_expires_at < NOW())
         )
       RETURNING ds.attempts, n.user_id, n.priority, n.content`,
      [notificationId, channel, leaseSeconds]
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      notificationId,
      channel,
      userId: row.user_id,
      priority: row.priority,
      content: row.content,
      attempt: row.attempts,
    };
  }

  /**
   * Records the final result of a claimed delivery. The `attempts = attempt`
   * guard is the fencing check: if this worker's lease expired and another
   * worker re-claimed the row, this late write is ignored. Returns false then.
   */
  async complete(
    delivery: ClaimedDelivery,
    status: 'sent' | 'failed',
    details: Record<string, unknown> = {}
  ): Promise<boolean> {
    return withTransaction(async (client) => {
      await this.lockNotification(client, delivery.notificationId);
      const updated = await client.query(
        `UPDATE delivery_status
         SET status = $3, lease_expires_at = NULL, details = details || $5::jsonb, updated_at = NOW()
         WHERE notification_id = $1 AND channel = $2 AND status = 'sending' AND attempts = $4`,
        [delivery.notificationId, delivery.channel, status, delivery.attempt, JSON.stringify(details)]
      );
      if (updated.rowCount === 0) return false;
      await this.recomputeNotificationStatus(client, delivery.notificationId);
      return true;
    });
  }

  /**
   * Puts a claimed delivery back as 'retrying' and writes the retry as an
   * outbox row due after `delayMs`, in one transaction: the retry survives a
   * worker crash, unlike the old in-process setTimeout republish. When
   * `countAttempt` is false (the provider's circuit was open) the attempt is
   * handed back so a provider outage does not burn the retry budget.
   */
  async scheduleRetry(
    delivery: ClaimedDelivery,
    delayMs: number,
    details: Record<string, unknown> = {},
    countAttempt: boolean = true
  ): Promise<Date | null> {
    return withTransaction(async (client) => {
      await this.lockNotification(client, delivery.notificationId);
      const updated = await client.query<{ next_retry_at: Date }>(
        `UPDATE delivery_status
         SET status = 'retrying',
             lease_expires_at = NULL,
             attempts = attempts - $4,
             next_retry_at = NOW() + make_interval(secs => $5),
             details = details || $6::jsonb,
             updated_at = NOW()
         WHERE notification_id = $1 AND channel = $2 AND status = 'sending' AND attempts = $3
         RETURNING next_retry_at`,
        [
          delivery.notificationId,
          delivery.channel,
          delivery.attempt,
          countAttempt ? 0 : 1,
          Math.max(0, delayMs) / 1000,
          JSON.stringify(details),
        ]
      );
      const row = updated.rows[0];
      if (!row) return null;

      await enqueueDeliveries(client, [{
        notificationId: delivery.notificationId,
        userId: delivery.userId,
        channel: delivery.channel,
        priority: delivery.priority,
        availableAt: row.next_retry_at,
      }]);
      await this.recomputeNotificationStatus(client, delivery.notificationId);
      return row.next_retry_at;
    });
  }

  /**
   * Re-enqueues deliveries whose worker died mid-send (lease expired by more
   * than `graceSeconds`). Without this, a redelivered message that arrives
   * while the dead worker's lease is still live is skipped, and the row would
   * sit in 'sending' forever.
   */
  async reapExpiredLeases(graceSeconds: number = 30): Promise<number> {
    const result = await query(
      `WITH expired AS (
         UPDATE delivery_status ds
         SET status = 'retrying', lease_expires_at = NULL, next_retry_at = NOW(), updated_at = NOW()
         FROM notifications n
         WHERE n.id = ds.notification_id
           AND ds.status = 'sending'
           AND ds.lease_expires_at < NOW() - make_interval(secs => $1)
         RETURNING ds.notification_id, ds.channel, n.user_id, n.priority
       )
       INSERT INTO delivery_outbox (notification_id, channel, priority, priority_rank, payload, available_at)
       SELECT notification_id, channel, priority,
              CASE priority WHEN 'critical' THEN ${PRIORITY_RANK.critical} WHEN 'high' THEN ${PRIORITY_RANK.high}
                            WHEN 'low' THEN ${PRIORITY_RANK.low} ELSE ${PRIORITY_RANK.normal} END,
              jsonb_build_object('notificationId', notification_id, 'userId', user_id, 'channel', channel,
                                 'priority', priority, 'queuedAt', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
              NOW()
       FROM expired`,
      [graceSeconds]
    );
    return result.rowCount ?? 0;
  }

  /**
   * Cancels a pending or scheduled notification: every delivery that has not
   * started becomes 'cancelled' and its unpublished outbox rows are deleted.
   * A delivery already in flight finishes, but cannot un-cancel the notification.
   */
  async cancel(notificationId: string, userId: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const cancelled = await client.query(
        `UPDATE notifications SET status = 'cancelled'
         WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'scheduled')
         RETURNING id`,
        [notificationId, userId]
      );
      if (cancelled.rowCount === 0) return false;

      await client.query(
        `UPDATE delivery_status
         SET status = 'cancelled', lease_expires_at = NULL, next_retry_at = NULL, updated_at = NOW()
         WHERE notification_id = $1 AND status IN ('pending', 'retrying')`,
        [notificationId]
      );
      await client.query(
        `DELETE FROM delivery_outbox WHERE notification_id = $1 AND published_at IS NULL`,
        [notificationId]
      );
      return true;
    });
  }

  /** Row lock on the notification: serializes concurrent channel results. */
  private async lockNotification(client: PoolClient, notificationId: string): Promise<void> {
    await client.query(`SELECT id FROM notifications WHERE id = $1 FOR UPDATE`, [notificationId]);
  }

  /**
   * Recomputes the aggregate under the notification row lock. Before, two
   * channel workers each read the delivery rows and wrote an aggregate without
   * a lock, so the slower writer could store 'partial' after both had succeeded.
   */
  async recomputeNotificationStatus(client: PoolClient, notificationId: string): Promise<void> {
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM delivery_status WHERE notification_id = $1`,
      [notificationId]
    );
    const next = aggregateStatus(rows.map((row) => row.status));
    if (!next) return;

    await client.query(
      `UPDATE notifications
       SET status = $2::varchar,
           delivered_at = CASE WHEN $2::varchar = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END
       WHERE id = $1
         AND status <> 'cancelled'
         AND NOT (status = 'scheduled' AND $2::varchar = 'pending')`,
      [notificationId, next]
    );
  }

  async trackEvent(
    notificationId: string,
    channel: string,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    await query(
      `INSERT INTO notification_events
         (notification_id, channel, event_type, metadata, occurred_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [notificationId, channel, eventType, JSON.stringify(metadata)]
    );
  }

  async getNotificationStatus(notificationId: string): Promise<NotificationWithDeliveryStatus | null> {
    const notification = await query<NotificationWithDeliveryStatus>(
      `SELECT n.*, json_agg(ds.*) as delivery_statuses
       FROM notifications n
       LEFT JOIN delivery_status ds ON n.id = ds.notification_id
       WHERE n.id = $1
       GROUP BY n.id`,
      [notificationId]
    );

    if (notification.rows.length === 0) {
      return null;
    }

    return notification.rows[0];
  }

  async getDeliveryStats(timeRange: string = '24 hours'): Promise<DeliveryStats> {
    const result = await query<DeliveryStatsRow>(
      `SELECT
         channel,
         status,
         COUNT(*) as count
       FROM delivery_status
       WHERE updated_at >= NOW() - $1::interval
       GROUP BY channel, status
       ORDER BY channel, status`,
      [timeRange]
    );

    const stats: DeliveryStats = {};
    for (const row of result.rows) {
      if (!stats[row.channel]) {
        stats[row.channel] = {};
      }
      stats[row.channel][row.status] = parseInt(row.count);
    }

    return stats;
  }

  /**
   * Deliveries waiting or in flight, by channel and priority — the real backlog.
   * (The admin view used to read Redis lists that nothing ever wrote.)
   */
  async getBacklog(): Promise<DeliveryStats> {
    const result = await query<{ channel: string; priority: string; count: string }>(
      `SELECT ds.channel, n.priority, COUNT(*) AS count
       FROM delivery_status ds
       JOIN notifications n ON n.id = ds.notification_id
       WHERE ds.status IN ('pending', 'sending', 'retrying') AND n.status <> 'scheduled'
       GROUP BY ds.channel, n.priority`
    );

    const backlog: DeliveryStats = {};
    for (const channel of ['push', 'email', 'sms']) {
      backlog[channel] = { critical: 0, high: 0, normal: 0, low: 0 };
    }
    for (const row of result.rows) {
      backlog[row.channel] = backlog[row.channel] || {};
      backlog[row.channel][row.priority] = parseInt(row.count);
    }
    return backlog;
  }
}

export const deduplicationService = new DeduplicationService();
export const deliveryTracker = new DeliveryTracker();
