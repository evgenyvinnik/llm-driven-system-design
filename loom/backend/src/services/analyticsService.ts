import { pool } from './db.js';
import { logger } from './logger.js';

/** Aggregated video analytics including views, unique viewers, watch duration, and completion rate. */
export interface AnalyticsSummary {
  totalViews: number;
  uniqueViewers: number;
  avgWatchDurationSeconds: number;
  completionRate: number;
  viewsByDay: { date: string; views: number }[];
}

/** Retrieves aggregated analytics for a video over a given number of days. */
export async function getVideoAnalytics(
  videoId: string,
  days: number = 30,
): Promise<AnalyticsSummary> {
  try {
    // Total views and unique viewers
    const statsResult = await pool.query(
      `SELECT
        COUNT(*) as total_views,
        COUNT(DISTINCT COALESCE(viewer_id::text, session_id)) as unique_viewers,
        COALESCE(AVG(watch_duration_seconds), 0) as avg_watch_duration,
        CASE
          WHEN COUNT(*) > 0
          THEN (COUNT(*) FILTER (WHERE completed = true)::float / COUNT(*)::float) * 100
          ELSE 0
        END as completion_rate
      FROM view_events
      WHERE video_id = $1
        AND created_at >= NOW() - INTERVAL '1 day' * $2`,
      [videoId, days],
    );

    const stats = statsResult.rows[0];

    // Views by day
    const dailyResult = await pool.query(
      `SELECT
        DATE(created_at) as date,
        COUNT(*) as views
      FROM view_events
      WHERE video_id = $1
        AND created_at >= NOW() - INTERVAL '1 day' * $2
      GROUP BY DATE(created_at)
      ORDER BY date ASC`,
      [videoId, days],
    );

    return {
      totalViews: parseInt(stats.total_views, 10),
      uniqueViewers: parseInt(stats.unique_viewers, 10),
      avgWatchDurationSeconds: parseFloat(stats.avg_watch_duration),
      completionRate: parseFloat(stats.completion_rate),
      viewsByDay: dailyResult.rows.map((row) => ({
        date: row.date.toISOString().split('T')[0],
        views: parseInt(row.views, 10),
      })),
    };
  } catch (err) {
    logger.error({ err, videoId }, 'Failed to get video analytics');
    throw err;
  }
}

export interface ViewReport {
  /** Client-generated id for one playback session; every heartbeat repeats it. */
  viewId: string;
  videoId: string;
  viewerId: string | null;
  /** Stable anonymous viewer key, used for unique-viewer counts when there is no account. */
  sessionId: string;
  watchDurationSeconds: number;
  completed: boolean;
  ipAddress: string;
  userAgent: string;
}

/**
 * Records a view or a heartbeat for one, in a single statement.
 *
 * The first report for a view id inserts the row and bumps `videos.view_count`; every
 * later report (heartbeats, retries, a beacon on page hide) updates the same row, and
 * only ever upward: watch time takes the max and `completed` can only turn true. So a
 * retried or reordered request can neither double-count a view nor shrink its watch
 * time, and the counter can't drift from the rows because both writes are one statement.
 * `xmax = 0` is PostgreSQL's tell for "this row was inserted, not updated".
 */
export async function recordView(report: ViewReport): Promise<'new' | 'heartbeat' | 'ignored'> {
  const { rows } = await pool.query(
    `WITH upsert AS (
       INSERT INTO view_events
         (id, video_id, viewer_id, session_id, watch_duration_seconds, completed, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE
         SET watch_duration_seconds = GREATEST(view_events.watch_duration_seconds, EXCLUDED.watch_duration_seconds),
             completed = view_events.completed OR EXCLUDED.completed
         WHERE view_events.video_id = EXCLUDED.video_id
       RETURNING (xmax = 0) AS inserted
     ),
     bump AS (
       UPDATE videos SET view_count = view_count + 1
       WHERE id = $2 AND EXISTS (SELECT 1 FROM upsert WHERE inserted)
       RETURNING id
     )
     SELECT (SELECT inserted FROM upsert) AS inserted`,
    [
      report.viewId,
      report.videoId,
      report.viewerId,
      report.sessionId,
      Math.round(report.watchDurationSeconds),
      report.completed,
      report.ipAddress,
      report.userAgent.slice(0, 512),
    ],
  );
  const inserted = rows[0]?.inserted;
  if (inserted === true) return 'new';
  if (inserted === false) return 'heartbeat';
  // A view id that already belongs to another video: nothing was written.
  return 'ignored';
}
