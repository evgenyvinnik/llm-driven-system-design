import { query } from '../utils/database.js';
import { ClickEvent, ClickEventInput, UrlAnalytics } from '../models/types.js';
import { ClickEventMessage } from '../utils/queue.js';
import { incrementClickCount } from './urlService.js';

/**
 * Parses a User-Agent string to determine device type.
 * Used for analytics to segment traffic by device category.
 * @param userAgent - The User-Agent header value
 * @returns Device type: 'mobile', 'tablet', 'desktop', 'bot', or 'unknown'
 */
function parseDeviceType(userAgent: string | undefined): string {
  if (!userAgent) return 'unknown';

  const ua = userAgent.toLowerCase();

  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    return 'mobile';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'tablet';
  }
  if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) {
    return 'bot';
  }
  return 'desktop';
}

/**
 * Records a click event in the database.
 * Called asynchronously during redirects to capture analytics data.
 * @deprecated Use queue-based recording with publishClickEvent() instead.
 * @param input - Click event data including short code and request metadata
 */
export async function recordClick(input: ClickEventInput): Promise<void> {
  const deviceType = parseDeviceType(input.user_agent);

  await query(
    `INSERT INTO click_events (short_code, referrer, user_agent, ip_address, device_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.short_code,
      input.referrer || null,
      input.user_agent || null,
      input.ip_address || null,
      deviceType,
    ]
  );
}

/**
 * Records a click event synchronously (fallback when queue is unavailable).
 * Also increments the URL click count.
 * @param event - Click event message data
 */
export async function recordClickSync(event: ClickEventMessage): Promise<void> {
  await query(
    `INSERT INTO click_events (short_code, referrer, user_agent, ip_address, device_type, clicked_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.short_code,
      event.referrer || null,
      event.user_agent || null,
      event.ip_address || null,
      event.device_type,
      new Date(event.timestamp),
    ]
  );

  // Also increment click count
  await incrementClickCount(event.short_code);
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
  clicksByHour: { hour: number; count: number }[];
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

  // Clicks by hour (last 24 hours)
  const clicksByHour = await query<{ hour: string; count: string }>(
    `SELECT EXTRACT(HOUR FROM clicked_at) as hour, COUNT(*) as count
     FROM click_events
     WHERE clicked_at > NOW() - INTERVAL '24 hours'
     GROUP BY EXTRACT(HOUR FROM clicked_at)
     ORDER BY hour`
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
      hour: parseInt(row.hour, 10),
      count: parseInt(row.count, 10),
    })),
    topUrls: topUrls.map((row) => ({
      short_code: row.short_code,
      count: parseInt(row.count, 10),
    })),
  };
}
