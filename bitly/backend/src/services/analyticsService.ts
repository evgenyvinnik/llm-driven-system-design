import { query } from '../utils/database.js';
import { ClickEvent, ClickEventInput, UrlAnalytics } from '../models/types.js';

// Parse user agent to detect device type
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

// Record a click event
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

// Get analytics for a URL
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

// Get recent clicks for a URL
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

// Get global analytics (for admin dashboard)
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
