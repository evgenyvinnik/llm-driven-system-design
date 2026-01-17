import { Router } from 'express';
import { query } from '../utils/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getAchievementsWithProgress } from '../services/achievements.js';

const router = Router();

// Get user's overall stats
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    // Overall stats
    const overallResult = await query(
      `SELECT
        COUNT(*) as total_activities,
        COALESCE(SUM(distance), 0) as total_distance,
        COALESCE(SUM(elapsed_time), 0) as total_time,
        COALESCE(SUM(elevation_gain), 0) as total_elevation
       FROM activities
       WHERE user_id = $1`,
      [userId]
    );

    // Stats by type
    const byTypeResult = await query(
      `SELECT
        type,
        COUNT(*) as activity_count,
        COALESCE(SUM(distance), 0) as total_distance,
        COALESCE(SUM(elapsed_time), 0) as total_time,
        COALESCE(SUM(elevation_gain), 0) as total_elevation
       FROM activities
       WHERE user_id = $1
       GROUP BY type
       ORDER BY activity_count DESC`,
      [userId]
    );

    // Recent weekly stats (last 4 weeks)
    const weeklyResult = await query(
      `SELECT
        DATE_TRUNC('week', start_time) as week,
        COUNT(*) as activity_count,
        COALESCE(SUM(distance), 0) as total_distance,
        COALESCE(SUM(elapsed_time), 0) as total_time
       FROM activities
       WHERE user_id = $1
         AND start_time >= NOW() - INTERVAL '4 weeks'
       GROUP BY week
       ORDER BY week DESC`,
      [userId]
    );

    // Segment efforts
    const effortsResult = await query(
      `SELECT
        COUNT(*) as total_efforts,
        COUNT(DISTINCT segment_id) as unique_segments,
        COUNT(CASE WHEN pr_rank <= 3 THEN 1 END) as podium_finishes
       FROM segment_efforts
       WHERE user_id = $1`,
      [userId]
    );

    // Total kudos received
    const kudosResult = await query(
      `SELECT COUNT(*) as total_kudos
       FROM kudos k
       JOIN activities a ON k.activity_id = a.id
       WHERE a.user_id = $1`,
      [userId]
    );

    // Achievements
    const achievements = await getAchievementsWithProgress(userId);

    res.json({
      overall: overallResult.rows[0],
      byType: byTypeResult.rows,
      weekly: weeklyResult.rows,
      segments: effortsResult.rows[0],
      kudosReceived: parseInt(kudosResult.rows[0].total_kudos),
      achievements
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get user's personal records
router.get('/me/records', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    // Longest activities by type
    const longestResult = await query(
      `SELECT DISTINCT ON (type)
        id, name, type, distance, elapsed_time, start_time
       FROM activities
       WHERE user_id = $1
       ORDER BY type, distance DESC`,
      [userId]
    );

    // Fastest activities by type (based on avg speed)
    const fastestResult = await query(
      `SELECT DISTINCT ON (type)
        id, name, type, distance, avg_speed, start_time
       FROM activities
       WHERE user_id = $1 AND avg_speed > 0
       ORDER BY type, avg_speed DESC`,
      [userId]
    );

    // Most elevation
    const climbResult = await query(
      `SELECT id, name, type, elevation_gain, start_time
       FROM activities
       WHERE user_id = $1
       ORDER BY elevation_gain DESC
       LIMIT 1`,
      [userId]
    );

    // Best segment times (top 3)
    const segmentPRs = await query(
      `SELECT se.elapsed_time, s.name as segment_name, s.distance, a.start_time as achieved_at
       FROM segment_efforts se
       JOIN segments s ON se.segment_id = s.id
       JOIN activities a ON se.activity_id = a.id
       WHERE se.user_id = $1 AND se.pr_rank <= 3
       ORDER BY se.pr_rank, se.created_at DESC
       LIMIT 10`,
      [userId]
    );

    res.json({
      longestByType: longestResult.rows,
      fastestByType: fastestResult.rows,
      biggestClimb: climbResult.rows[0] || null,
      segmentPRs: segmentPRs.rows
    });
  } catch (error) {
    console.error('Get records error:', error);
    res.status(500).json({ error: 'Failed to get records' });
  }
});

// Admin: Get platform-wide stats
router.get('/admin/overview', requireAdmin, async (req, res) => {
  try {
    // User counts
    const userStats = await query(
      `SELECT
        COUNT(*) as total_users,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as new_users_week,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as new_users_month
       FROM users`
    );

    // Activity counts
    const activityStats = await query(
      `SELECT
        COUNT(*) as total_activities,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as activities_week,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as activities_today
       FROM activities`
    );

    // Activity type distribution
    const typeDistribution = await query(
      `SELECT type, COUNT(*) as count
       FROM activities
       GROUP BY type
       ORDER BY count DESC`
    );

    // Segment stats
    const segmentStats = await query(
      `SELECT
        COUNT(*) as total_segments,
        (SELECT COUNT(*) FROM segment_efforts) as total_efforts
       FROM segments`
    );

    // Top activities by kudos this week
    const topActivities = await query(
      `SELECT a.id, a.name, a.type, a.kudos_count, u.username
       FROM activities a
       JOIN users u ON a.user_id = u.id
       WHERE a.created_at >= NOW() - INTERVAL '7 days'
       ORDER BY a.kudos_count DESC
       LIMIT 10`
    );

    res.json({
      users: userStats.rows[0],
      activities: activityStats.rows[0],
      typeDistribution: typeDistribution.rows,
      segments: segmentStats.rows[0],
      topActivities: topActivities.rows
    });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: 'Failed to get admin stats' });
  }
});

export default router;
