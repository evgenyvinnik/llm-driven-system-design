import { Router } from 'express';
import { query } from '../utils/db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { getLeaderboard, getUserRank } from '../utils/redis.js';
import { createSegmentFromActivity } from '../services/segmentMatcher.js';

const router = Router();

// Get all segments (paginated, with search)
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type;
    const search = req.query.search;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius) || 10; // km

    let whereClause = 'WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (type) {
      whereClause += ` AND activity_type = $${paramIndex++}`;
      params.push(type);
    }

    if (search) {
      whereClause += ` AND name ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    // Location-based search
    if (!isNaN(lat) && !isNaN(lng)) {
      const radiusDegrees = radius / 111; // roughly km to degrees
      whereClause += ` AND start_lat BETWEEN $${paramIndex++} AND $${paramIndex++}`;
      whereClause += ` AND start_lng BETWEEN $${paramIndex++} AND $${paramIndex++}`;
      params.push(lat - radiusDegrees, lat + radiusDegrees, lng - radiusDegrees, lng + radiusDegrees);
    }

    params.push(limit, offset);

    const result = await query(
      `SELECT s.*, u.username as creator_name
       FROM segments s
       JOIN users u ON s.creator_id = u.id
       ${whereClause}
       ORDER BY s.effort_count DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    res.json({ segments: result.rows });
  } catch (error) {
    console.error('Get segments error:', error);
    res.status(500).json({ error: 'Failed to get segments' });
  }
});

// Get single segment with leaderboard
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT s.*, u.username as creator_name
       FROM segments s
       JOIN users u ON s.creator_id = u.id
       WHERE s.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Segment not found' });
    }

    const segment = result.rows[0];

    // Get leaderboard from Redis
    const leaderboard = await getLeaderboard(id, 10);

    // Enrich with user data
    const enrichedLeaderboard = [];
    for (const entry of leaderboard) {
      const userResult = await query(
        'SELECT id, username, profile_photo FROM users WHERE id = $1',
        [entry.userId]
      );
      if (userResult.rows.length > 0) {
        enrichedLeaderboard.push({
          ...entry,
          user: userResult.rows[0]
        });
      }
    }

    // Get current user's rank if logged in
    let userRank = null;
    if (req.session?.userId) {
      userRank = await getUserRank(id, req.session.userId);
    }

    res.json({
      ...segment,
      leaderboard: enrichedLeaderboard,
      userRank
    });
  } catch (error) {
    console.error('Get segment error:', error);
    res.status(500).json({ error: 'Failed to get segment' });
  }
});

// Get segment leaderboard
router.get('/:id/leaderboard', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const filter = req.query.filter || 'overall';

    let leaderboard;

    if (filter === 'overall') {
      // Get from Redis
      leaderboard = await getLeaderboard(id, limit);

      // Enrich with user data
      const enrichedLeaderboard = [];
      for (const entry of leaderboard) {
        const userResult = await query(
          'SELECT id, username, profile_photo FROM users WHERE id = $1',
          [entry.userId]
        );
        if (userResult.rows.length > 0) {
          enrichedLeaderboard.push({
            ...entry,
            user: userResult.rows[0]
          });
        }
      }
      leaderboard = enrichedLeaderboard;
    } else if (filter === 'friends' && req.session?.userId) {
      // Get from database filtered by friends
      const result = await query(
        `SELECT se.elapsed_time, u.id, u.username, u.profile_photo,
                ROW_NUMBER() OVER (ORDER BY se.elapsed_time ASC) as rank
         FROM segment_efforts se
         JOIN users u ON se.user_id = u.id
         WHERE se.segment_id = $1
           AND se.user_id IN (SELECT following_id FROM follows WHERE follower_id = $2)
         ORDER BY se.elapsed_time ASC
         LIMIT $3`,
        [id, req.session.userId, limit]
      );

      leaderboard = result.rows.map(row => ({
        rank: parseInt(row.rank),
        elapsedTime: row.elapsed_time,
        user: {
          id: row.id,
          username: row.username,
          profile_photo: row.profile_photo
        }
      }));
    } else {
      // Overall leaderboard from database as fallback
      const result = await query(
        `SELECT DISTINCT ON (se.user_id) se.elapsed_time, u.id, u.username, u.profile_photo
         FROM segment_efforts se
         JOIN users u ON se.user_id = u.id
         WHERE se.segment_id = $1
         ORDER BY se.user_id, se.elapsed_time ASC`,
        [id]
      );

      // Sort by elapsed time and add ranks
      const sorted = result.rows.sort((a, b) => a.elapsed_time - b.elapsed_time);
      leaderboard = sorted.slice(0, limit).map((row, idx) => ({
        rank: idx + 1,
        elapsedTime: row.elapsed_time,
        user: {
          id: row.id,
          username: row.username,
          profile_photo: row.profile_photo
        }
      }));
    }

    res.json({ leaderboard });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// Create segment from activity
router.post('/', requireAuth, async (req, res) => {
  try {
    const { activityId, startIndex, endIndex, name } = req.body;
    const userId = req.session.userId;

    if (!activityId || startIndex === undefined || endIndex === undefined || !name) {
      return res.status(400).json({ error: 'activityId, startIndex, endIndex, and name are required' });
    }

    if (endIndex - startIndex < 10) {
      return res.status(400).json({ error: 'Segment must contain at least 10 GPS points' });
    }

    // Verify user owns the activity
    const activityResult = await query(
      'SELECT user_id FROM activities WHERE id = $1',
      [activityId]
    );

    if (activityResult.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    if (activityResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'You can only create segments from your own activities' });
    }

    const segment = await createSegmentFromActivity(activityId, startIndex, endIndex, name, userId);

    res.status(201).json({ segment });
  } catch (error) {
    console.error('Create segment error:', error);
    res.status(500).json({ error: 'Failed to create segment' });
  }
});

// Get user's efforts on a segment
router.get('/:id/efforts', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.query.userId || req.session?.userId;

    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }

    const result = await query(
      `SELECT se.*, a.name as activity_name, a.start_time as activity_date
       FROM segment_efforts se
       JOIN activities a ON se.activity_id = a.id
       WHERE se.segment_id = $1 AND se.user_id = $2
       ORDER BY se.elapsed_time ASC`,
      [id, userId]
    );

    res.json({ efforts: result.rows });
  } catch (error) {
    console.error('Get efforts error:', error);
    res.status(500).json({ error: 'Failed to get efforts' });
  }
});

// Delete segment (creator only)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    const result = await query(
      'DELETE FROM segments WHERE id = $1 AND creator_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Segment not found or not owned by you' });
    }

    res.json({ message: 'Segment deleted' });
  } catch (error) {
    console.error('Delete segment error:', error);
    res.status(500).json({ error: 'Failed to delete segment' });
  }
});

export default router;
