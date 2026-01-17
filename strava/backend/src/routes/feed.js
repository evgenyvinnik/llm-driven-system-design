import { Router } from 'express';
import { query } from '../utils/db.js';
import { requireAuth } from '../middleware/auth.js';
import { getFeed } from '../utils/redis.js';

const router = Router();

// Get personalized activity feed
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const limit = parseInt(req.query.limit) || 20;
    const before = req.query.before ? parseInt(req.query.before) : null;

    // Get activity IDs from Redis feed
    const activityIds = await getFeed(userId, limit, before);

    if (activityIds.length === 0) {
      // If no feed exists, get recent activities from followed users
      const result = await query(
        `SELECT a.*, u.username, u.profile_photo,
                (SELECT COUNT(*) FROM kudos WHERE activity_id = a.id) as kudos_count,
                (SELECT COUNT(*) FROM comments WHERE activity_id = a.id) as comment_count,
                EXISTS(SELECT 1 FROM kudos WHERE activity_id = a.id AND user_id = $1) as has_kudos
         FROM activities a
         JOIN users u ON a.user_id = u.id
         WHERE a.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
            OR a.user_id = $1
         ORDER BY a.start_time DESC
         LIMIT $2`,
        [userId, limit]
      );

      return res.json({ activities: result.rows });
    }

    // Fetch activities by IDs (maintaining order)
    const placeholders = activityIds.map((_, i) => `$${i + 2}`).join(',');
    const result = await query(
      `SELECT a.*, u.username, u.profile_photo,
              (SELECT COUNT(*) FROM kudos WHERE activity_id = a.id) as kudos_count,
              (SELECT COUNT(*) FROM comments WHERE activity_id = a.id) as comment_count,
              EXISTS(SELECT 1 FROM kudos WHERE activity_id = a.id AND user_id = $1) as has_kudos
       FROM activities a
       JOIN users u ON a.user_id = u.id
       WHERE a.id IN (${placeholders})`,
      [userId, ...activityIds]
    );

    // Sort by the order from Redis
    const activityMap = new Map(result.rows.map(a => [a.id, a]));
    const orderedActivities = activityIds
      .map(id => activityMap.get(id))
      .filter(Boolean);

    res.json({ activities: orderedActivities });
  } catch (error) {
    console.error('Get feed error:', error);
    res.status(500).json({ error: 'Failed to get feed' });
  }
});

// Get global/explore feed (public activities)
router.get('/explore', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type;

    let whereClause = "WHERE a.privacy = 'public'";
    const params = [];
    let paramIndex = 1;

    if (type) {
      whereClause += ` AND a.type = $${paramIndex++}`;
      params.push(type);
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT a.*, u.username, u.profile_photo,
              (SELECT COUNT(*) FROM kudos WHERE activity_id = a.id) as kudos_count,
              (SELECT COUNT(*) FROM comments WHERE activity_id = a.id) as comment_count
       FROM activities a
       JOIN users u ON a.user_id = u.id
       ${whereClause}
       ORDER BY a.start_time DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    res.json({ activities: result.rows });
  } catch (error) {
    console.error('Get explore feed error:', error);
    res.status(500).json({ error: 'Failed to get explore feed' });
  }
});

export default router;
