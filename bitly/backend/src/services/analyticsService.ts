import { query, withTransaction } from '../utils/database.js';
import { ClickEvent, ClickEventMessage, UrlAnalytics } from '../models/types.js';
import { isQueueConnected, publishClickEvent } from '../utils/queue.js';
import logger from '../utils/logger.js';
import { clickEventsTotal, clickEventDispatchTotal, clickEventsDuplicateTotal } from '../utils/metrics.js';

/**
 * Persists one click event exactly once.
 * The INSERT is keyed by event_id (unique index) with ON CONFLICT DO NOTHING, and the
 * denormalized urls.click_count is incremented only when that INSERT actually added a
 * row, in the same transaction. A redelivered message, a publisher retry, or a sync
 * fallback racing a late broker confirm therefore never double counts, and a crash can
 * never leave the event without its counter increment (or vice versa).
 * Used by both the analytics worker and the synchronous fallback.
 * @param event - Click event carrying its event_id
 * @returns true if the click was recorded, false if it was a duplicate
 */
export async function recordClickEvent(event: ClickEventMessage): Promise<boolean> {
  const recorded = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO click_events
         (event_id, short_code, referrer, user_agent, ip_address, device_type, clicked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [
        event.event_id,
        event.short_code,
        event.referrer || null,
        event.user_agent || null,
        event.ip_address || null,
        event.device_type,
        new Date(event.timestamp),
      ]
    );

    if ((inserted.rowCount ?? 0) === 0) {
      return false; // Already recorded: do not touch the counter again.
    }

    await client.query(
      `UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1`,
      [event.short_code]
    );
    return true;
  });

  if (!recorded) {
    clickEventsDuplicateTotal.inc();
    logger.info({ event_id: event.event_id, short_code: event.short_code }, 'Duplicate click event ignored');
  }
  return recorded;
}

/**
 * Records a click event synchronously (fallback when the queue is unavailable or a
 * publish was not confirmed). Same idempotent write as the worker.
 * @param event - Click event message data
 * @returns true if recorded, false if it was a duplicate
 */
export async function recordClickSync(event: ClickEventMessage): Promise<boolean> {
  return recordClickEvent(event);
}

/** Click dispatches still running; awaited during graceful shutdown. */
const pendingDispatches = new Set<Promise<void>>();

/**
 * Hands a click event to the analytics pipeline without blocking the caller.
 * Called after the redirect response has been sent. Publishes to RabbitMQ and waits for
 * the publisher confirm; if the queue is down, the confirm is negative, or it times
 * out, the click is inserted directly instead. Both paths share the event_id, so a late
 * confirm plus the fallback still yields one row.
 * @param event - Click event with event_id assigned at the redirect
 */
export function dispatchClickEvent(event: ClickEventMessage): void {
  const task = (async (): Promise<void> => {
    try {
      const queueAvailable = isQueueConnected();
      if (queueAvailable && (await publishClickEvent(event))) {
        clickEventDispatchTotal.inc({ path: 'queue' });
      } else {
        logger.warn(
          { short_code: event.short_code, event_id: event.event_id },
          queueAvailable ? 'Click event not confirmed, using sync recording' : 'Queue unavailable, using sync recording'
        );
        await recordClickSync(event);
        clickEventDispatchTotal.inc({ path: 'sync' });
      }
      clickEventsTotal.inc({ device_type: event.device_type });
    } catch (error) {
      clickEventDispatchTotal.inc({ path: 'failed' });
      logger.error({ err: error, short_code: event.short_code, event_id: event.event_id }, 'Failed to record click');
    }
  })();

  pendingDispatches.add(task);
  void task.finally(() => {
    pendingDispatches.delete(task);
  });
}

/**
 * Waits for in-flight click dispatches (bounded), so a graceful shutdown does not drop
 * clicks whose redirect was already served.
 * @param timeoutMs - Maximum time to wait
 */
export async function waitForPendingClickDispatches(timeoutMs: number): Promise<void> {
  if (pendingDispatches.size === 0) {
    return;
  }
  await Promise.race([
    Promise.allSettled([...pendingDispatches]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/**
 * Retrieves aggregated analytics data for a single URL.
 * Includes total clicks, daily trends, referrer sources, and device breakdown.
 * @param shortCode - The short code to get analytics for
 * @returns Promise resolving to analytics data or null if URL not found
 */
export async function getUrlAnalytics(shortCode: string): Promise<UrlAnalytics | null> {
  // Get total clicks
  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM click_events WHERE short_code = $1`,
    [shortCode]
  );

  if (parseInt(totalResult[0].count, 10) === 0) {
    // Check if URL exists
    const urlExists = await query<{ short_code: string }>(
      `SELECT short_code FROM urls WHERE short_code = $1`,
      [shortCode]
    );

    if (urlExists.length === 0) {
      return null;
    }
  }

  // Get clicks by day (last 30 days)
  const clicksByDay = await query<{ date: string; count: string }>(
    `SELECT DATE(clicked_at) as date, COUNT(*) as count
     FROM click_events
     WHERE short_code = $1
     AND clicked_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(clicked_at)
     ORDER BY date DESC`,
    [shortCode]
  );

  // Get top referrers
  const topReferrers = await query<{ referrer: string; count: string }>(
    `SELECT COALESCE(referrer, 'Direct') as referrer, COUNT(*) as count
     FROM click_events
     WHERE short_code = $1
     GROUP BY referrer
     ORDER BY count DESC
     LIMIT 10`,
    [shortCode]
  );

  // Get device breakdown
  const devices = await query<{ device: string; count: string }>(
    `SELECT device_type as device, COUNT(*) as count
     FROM click_events
     WHERE short_code = $1
     GROUP BY device_type
     ORDER BY count DESC`,
    [shortCode]
  );

  return {
    short_code: shortCode,
    total_clicks: parseInt(totalResult[0].count, 10),
    clicks_by_day: clicksByDay.map((row) => ({
      date: row.date,
      count: parseInt(row.count, 10),
    })),
    top_referrers: topReferrers.map((row) => ({
      referrer: row.referrer,
      count: parseInt(row.count, 10),
    })),
    devices: devices.map((row) => ({
      device: row.device,
      count: parseInt(row.count, 10),
    })),
  };
}

/**
 * Retrieves recent individual click events for a URL.
 * Used for detailed click-level analysis.
 * @param shortCode - The short code to get clicks for
 * @param limit - Maximum number of clicks to return (default: 100)
 * @returns Promise resolving to array of click events
 */
export async function getRecentClicks(
  shortCode: string,
  limit: number = 100
): Promise<ClickEvent[]> {
  return query<ClickEvent>(
    `SELECT * FROM click_events
     WHERE short_code = $1
     ORDER BY clicked_at DESC
     LIMIT $2`,
    [shortCode, limit]
  );
}

/**
 * Retrieves platform-wide analytics data for the admin dashboard.
 * Includes total clicks, today's activity, hourly trends, and top URLs.
 * @returns Promise resolving to global analytics data
 */
export async function getGlobalAnalytics(): Promise<{
  totalClicks: number;
  clicksToday: number;
  clicksByHour: { hour: string; count: number }[];
  topUrls: { short_code: string; count: number }[];
}> {
  // Total clicks
  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM click_events`
  );

  // Clicks today
  const todayResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM click_events
     WHERE clicked_at > DATE_TRUNC('day', NOW())`
  );

  // Clicks by hour (last 24 hours). Bucket by the full timestamp truncated to the hour:
  // grouping by hour-of-day alone merged today's 14:00 with yesterday's 14:00 at the
  // edges of the window and sorted by clock hour instead of time.
  const clicksByHour = await query<{ hour: Date; count: string }>(
    `SELECT date_trunc('hour', clicked_at) AS hour, COUNT(*) AS count
     FROM click_events
     WHERE clicked_at > NOW() - INTERVAL '24 hours'
     GROUP BY 1
     ORDER BY 1`
  );

  // Top URLs today
  const topUrls = await query<{ short_code: string; count: string }>(
    `SELECT short_code, COUNT(*) as count
     FROM click_events
     WHERE clicked_at > NOW() - INTERVAL '24 hours'
     GROUP BY short_code
     ORDER BY count DESC
     LIMIT 10`
  );

  return {
    totalClicks: parseInt(totalResult[0].count, 10),
    clicksToday: parseInt(todayResult[0].count, 10),
    clicksByHour: clicksByHour.map((row) => ({
      hour: new Date(row.hour).toISOString(), // start of the hour bucket
      count: parseInt(row.count, 10),
    })),
    topUrls: topUrls.map((row) => ({
      short_code: row.short_code,
      count: parseInt(row.count, 10),
    })),
  };
}
