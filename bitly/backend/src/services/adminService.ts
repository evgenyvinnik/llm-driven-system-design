import { query } from '../utils/database.js';
import { getKeyPoolStats } from './keyService.js';
import { SystemStats, Url } from '../models/types.js';

// Get comprehensive system statistics
export async function getSystemStats(): Promise<SystemStats> {
  // Total URLs
  const totalUrlsResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM urls`
  );

  // Active URLs
  const activeUrlsResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM urls WHERE is_active = true`
  );

  // Total clicks
  const totalClicksResult = await query<{ sum: string }>(
    `SELECT COALESCE(SUM(click_count), 0) as sum FROM urls`
  );

  // URLs created today
  const urlsTodayResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM urls
     WHERE created_at > DATE_TRUNC('day', NOW())`
  );

  // Clicks today
  const clicksTodayResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM click_events
     WHERE clicked_at > DATE_TRUNC('day', NOW())`
  );

  // Key pool stats
  const keyPoolStats = await getKeyPoolStats();

  // Top URLs by clicks
  const topUrls = await query<{ short_code: string; long_url: string; click_count: string }>(
    `SELECT short_code, long_url, click_count
     FROM urls
     WHERE is_active = true
     ORDER BY click_count DESC
     LIMIT 10`
  );

  return {
    total_urls: parseInt(totalUrlsResult[0].count, 10),
    total_clicks: parseInt(totalClicksResult[0].sum, 10),
    active_urls: parseInt(activeUrlsResult[0].count, 10),
    keys_available: keyPoolStats.available,
    keys_used: keyPoolStats.used,
    urls_created_today: parseInt(urlsTodayResult[0].count, 10),
    clicks_today: parseInt(clicksTodayResult[0].count, 10),
    top_urls: topUrls.map((row) => ({
      short_code: row.short_code,
      long_url: row.long_url,
      click_count: parseInt(row.click_count, 10),
    })),
  };
}

// Get all URLs (admin view)
export async function getAllUrls(
  limit: number = 50,
  offset: number = 0,
  filters?: {
    is_active?: boolean;
    is_custom?: boolean;
    search?: string;
  }
): Promise<{ urls: Url[]; total: number }> {
  let whereClause = '1=1';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters?.is_active !== undefined) {
    whereClause += ` AND is_active = $${paramIndex++}`;
    params.push(filters.is_active);
  }

  if (filters?.is_custom !== undefined) {
    whereClause += ` AND is_custom = $${paramIndex++}`;
    params.push(filters.is_custom);
  }

  if (filters?.search) {
    whereClause += ` AND (short_code ILIKE $${paramIndex} OR long_url ILIKE $${paramIndex++})`;
    params.push(`%${filters.search}%`);
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM urls WHERE ${whereClause}`,
    params
  );

  params.push(limit, offset);

  const urls = await query<Url>(
    `SELECT * FROM urls
     WHERE ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    params
  );

  return {
    urls,
    total: parseInt(countResult[0].count, 10),
  };
}

// Deactivate URL (admin action)
export async function adminDeactivateUrl(shortCode: string): Promise<boolean> {
  const result = await query<Url>(
    `UPDATE urls SET is_active = false WHERE short_code = $1 RETURNING *`,
    [shortCode]
  );

  return result.length > 0;
}

// Reactivate URL (admin action)
export async function adminReactivateUrl(shortCode: string): Promise<boolean> {
  const result = await query<Url>(
    `UPDATE urls SET is_active = true WHERE short_code = $1 RETURNING *`,
    [shortCode]
  );

  return result.length > 0;
}

// Get expired URLs for cleanup
export async function getExpiredUrls(limit: number = 1000): Promise<Url[]> {
  return query<Url>(
    `SELECT * FROM urls
     WHERE expires_at IS NOT NULL AND expires_at < NOW() AND is_active = true
     LIMIT $1`,
    [limit]
  );
}

// Cleanup expired URLs
export async function cleanupExpiredUrls(): Promise<number> {
  const result = await query<{ count: string }>(
    `WITH updated AS (
       UPDATE urls SET is_active = false
       WHERE expires_at IS NOT NULL AND expires_at < NOW() AND is_active = true
       RETURNING *
     )
     SELECT COUNT(*) as count FROM updated`
  );

  return parseInt(result[0].count, 10);
}
