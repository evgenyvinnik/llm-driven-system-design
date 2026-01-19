import { Router, Response } from 'express';
import { query } from '../../utils/db.js';
import { optionalAuth, AuthenticatedRequest } from '../../middleware/auth.js';
import { activityLogger as log, logError, ErrorWithCode } from '../../shared/logger.js';
import { ActivityRow, SegmentEffortRow, GpsPointRow } from './types.js';

const router = Router();

// Get all activities (paginated)
router.get('/', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const type = req.query.type as string | undefined;
    const queryUserId = req.query.userId as string | undefined;

    let whereClause = "WHERE a.privacy = 'public'";
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (type) {
      whereClause += ` AND a.type = $${paramIndex++}`;
      params.push(type);
    }

    if (queryUserId) {
      whereClause += ` AND a.user_id = $${paramIndex++}`;
      params.push(queryUserId);
    }

    params.push(limit, offset);

    const result = await query<ActivityRow>(
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
    logError(log, error as ErrorWithCode, 'Get activities error');
    res.status(500).json({ error: 'Failed to get activities' });
  }
});

// Get single activity
router.get('/:id', optionalAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query<ActivityRow>(
      `SELECT a.*, u.username, u.profile_photo
       FROM activities a
       JOIN users u ON a.user_id = u.id
       WHERE a.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Activity not found' });
      return;
    }

    const activity = result.rows[0];

    // Check privacy
    if (activity.privacy !== 'public' && activity.user_id !== req.session?.userId) {
      if (activity.privacy === 'followers' && req.session?.userId) {
        const followResult = await query<{ count: string }>(
          'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
          [req.session.userId, activity.user_id]
        );
        if (followResult.rows.length === 0) {
          res.status(403).json({ error: 'Activity is private' });
          return;
        }
      } else {
        res.status(403).json({ error: 'Activity is private' });
        return;
      }
    }

    // Get kudos count
    const kudosResult = await query<{ count: string }>(
      'SELECT COUNT(*) FROM kudos WHERE activity_id = $1',
      [id]
    );

    // Check if current user has given kudos
    let hasKudos = false;
    if (req.session?.userId) {
      const userKudosResult = await query<{ count: string }>(
        'SELECT 1 FROM kudos WHERE activity_id = $1 AND user_id = $2',
        [id, req.session.userId]
      );
      hasKudos = userKudosResult.rows.length > 0;
    }

    // Get segment efforts for this activity
    const effortsResult = await query<SegmentEffortRow>(
      `SELECT se.*, s.name as segment_name, s.distance as segment_distance
       FROM segment_efforts se
       JOIN segments s ON se.segment_id = s.id
       WHERE se.activity_id = $1
       ORDER BY se.start_index`,
      [id]
    );

    res.json({
      ...activity,
      kudosCount: parseInt(kudosResult.rows[0].count),
      hasKudos,
      segmentEfforts: effortsResult.rows
    });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Get activity error');
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// Get GPS points for activity
router.get('/:id/gps', optionalAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const activityResult = await query<{ user_id: string; privacy: string }>(
      'SELECT user_id, privacy FROM activities WHERE id = $1',
      [id]
    );

    if (activityResult.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const activity = activityResult.rows[0];

    if (activity.privacy !== 'public' && activity.user_id !== req.session?.userId) {
      res.status(403).json({ error: 'Activity is private' });
      return;
    }

    const result = await query<GpsPointRow>(
      `SELECT point_index, timestamp, latitude, longitude, altitude, speed, heart_rate, cadence, power
       FROM gps_points
       WHERE activity_id = $1
       ORDER BY point_index`,
      [id]
    );

    res.json({ points: result.rows });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Get GPS points error');
    res.status(500).json({ error: 'Failed to get GPS points' });
  }
});

// Get comments for an activity
router.get('/:id/comments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query<{
      id: string;
      content: string;
      created_at: Date;
      user_id: string;
      username: string;
      profile_photo: string | null;
    }>(
      `SELECT c.id, c.content, c.created_at, u.id as user_id, u.username, u.profile_photo
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.activity_id = $1
       ORDER BY c.created_at ASC`,
      [id]
    );

    res.json({ comments: result.rows });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Get comments error');
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

export default router;
