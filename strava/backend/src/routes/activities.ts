import { Router, Response } from 'express';
import multer, { Multer } from 'multer';
import { query } from '../utils/db.js';
import { requireAuth, optionalAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { addToFeed } from '../utils/redis.js';
import {
  parseGPX,
  calculateMetrics,
  encodePolyline,
  calculateBoundingBox,
  applyPrivacyZones,
  generateSampleRoute,
  GpsPoint,
  PrivacyZone
} from '../utils/gps.js';
import { matchActivityToSegments } from '../services/segmentMatcher.js';
import { checkAchievements } from '../services/achievements.js';

// Shared modules
import {
  activityUploadsTotal,
  activityUploadDuration,
  activityGpsPointsTotal,
  feedFanoutDuration
} from '../shared/metrics.js';
import { activityLogger as log, logError, ErrorWithCode } from '../shared/logger.js';
import { alerts, gps as gpsConfig } from '../shared/config.js';
import {
  checkIdempotency,
  storeIdempotencyKey,
  storeClientIdempotencyKey,
  ActivityData
} from '../shared/idempotency.js';

const router = Router();

interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload: Multer = multer({
  storage,
  limits: { fileSize: alerts.activityUpload.maxFileSizeBytes },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/gpx+xml' || file.originalname.endsWith('.gpx')) {
      cb(null, true);
    } else {
      cb(new Error('Only GPX files are allowed'));
    }
  }
});

interface UploadBody {
  type?: string;
  name?: string;
  description?: string;
  privacy?: string;
}

interface SimulateBody {
  type?: string;
  name?: string;
  startLat?: number;
  startLng?: number;
  numPoints?: number;
}

interface ActivityRow {
  id: string;
  user_id: string;
  type: string;
  name: string;
  description: string | null;
  start_time: Date;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  elevation_gain: number;
  avg_speed: number;
  max_speed: number;
  polyline: string;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  privacy: string;
  kudos_count: number;
  comment_count: number;
  created_at: Date;
  username?: string;
  profile_photo?: string | null;
}

interface SegmentEffortRow {
  id: string;
  segment_id: string;
  activity_id: string;
  elapsed_time: number;
  moving_time: number;
  start_index: number;
  end_index: number;
  segment_name: string;
  segment_distance: number;
}

interface CommentRow {
  id: string;
  content: string;
  created_at: Date;
  user_id: string;
  username: string;
  profile_photo: string | null;
}

interface GpsPointRow {
  point_index: number;
  timestamp: Date;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  heart_rate: number | null;
  cadence: number | null;
  power: number | null;
}

// Create activity from GPX upload
router.post('/upload', requireAuth, upload.single('file'), async (req: MulterRequest, res: Response) => {
  const uploadStart = Date.now();
  const userId = req.session.userId!;

  try {
    if (!req.file) {
      activityUploadsTotal.inc({ type: 'unknown', status: 'error_no_file' });
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const gpxContent = req.file.buffer.toString('utf-8');

    // Parse GPX first to get start timestamp for idempotency check
    const { name, points } = parseGPX(gpxContent);

    if (!points || points.length < gpsConfig.minActivityPoints) {
      activityUploadsTotal.inc({ type: 'unknown', status: 'error_invalid_gpx' });
      return res.status(400).json({ error: `GPX file must contain at least ${gpsConfig.minActivityPoints} track points` });
    }

    // Check GPS point limit
    if (points.length > alerts.activityUpload.maxGpsPoints) {
      activityUploadsTotal.inc({ type: 'unknown', status: 'error_too_many_points' });
      return res.status(400).json({
        error: `Activity has too many GPS points (${points.length}). Maximum is ${alerts.activityUpload.maxGpsPoints}.`
      });
    }

    const startTimestamp = points[0].timestamp;
    const body = req.body as UploadBody;
    const activityType = body.type || 'run';

    // Check for duplicate upload (idempotency)
    const existingActivity = await checkIdempotency(userId, gpxContent, startTimestamp);
    if (existingActivity) {
      log.info({
        userId,
        existingActivityId: existingActivity.id
      }, 'Duplicate activity upload detected');

      return res.status(200).json({
        activity: existingActivity,
        duplicate: true,
        message: 'Activity already uploaded'
      });
    }

    // Get user's privacy zones
    const privacyZonesResult = await query<PrivacyZone>(
      'SELECT center_lat as "centerLat", center_lng as "centerLng", radius_meters as "radiusMeters" FROM privacy_zones WHERE user_id = $1',
      [userId]
    );

    // Apply privacy zones
    const filteredPoints = applyPrivacyZones(points, privacyZonesResult.rows);

    // Calculate metrics
    const metrics = calculateMetrics(filteredPoints);

    // Generate polyline
    const polylineStr = encodePolyline(filteredPoints);

    // Get bounding box
    const bbox = calculateBoundingBox(filteredPoints);

    const activityName = body.name || name || `${activityType.charAt(0).toUpperCase() + activityType.slice(1)} Activity`;

    // Create activity record
    const activityResult = await query<ActivityRow>(
      `INSERT INTO activities (
        user_id, type, name, description, start_time, elapsed_time, moving_time,
        distance, elevation_gain, avg_speed, max_speed, polyline,
        start_lat, start_lng, end_lat, end_lng, privacy
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        userId,
        activityType,
        activityName,
        body.description || null,
        filteredPoints[0].timestamp || new Date(),
        metrics.elapsedTime,
        metrics.movingTime,
        metrics.distance,
        metrics.elevationGain,
        metrics.avgSpeed,
        metrics.maxSpeed,
        polylineStr,
        filteredPoints[0].latitude,
        filteredPoints[0].longitude,
        filteredPoints[filteredPoints.length - 1].latitude,
        filteredPoints[filteredPoints.length - 1].longitude,
        body.privacy || 'followers'
      ]
    );

    const activity = activityResult.rows[0];

    log.info({
      activityId: activity.id,
      userId,
      type: activityType,
      distance: metrics.distance,
      gpsPoints: filteredPoints.length
    }, 'Activity created');

    // Store GPS points
    for (let i = 0; i < filteredPoints.length; i++) {
      const pt = filteredPoints[i];
      await query(
        `INSERT INTO gps_points (activity_id, point_index, timestamp, latitude, longitude, altitude, heart_rate, cadence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [activity.id, i, pt.timestamp, pt.latitude, pt.longitude, pt.altitude, pt.heartRate, pt.cadence]
      );
    }

    // Record GPS points metric
    activityGpsPointsTotal.inc({ type: activityType }, filteredPoints.length);

    // Store idempotency key for future duplicate detection
    const activityData: ActivityData = {
      id: activity.id,
      name: activity.name,
      type: activity.type,
      start_time: activity.start_time,
      distance: activity.distance,
      elapsed_time: activity.elapsed_time
    };
    await storeIdempotencyKey(userId, gpxContent, startTimestamp, activityData);

    // Store client-provided idempotency key if present
    const clientKey = (req.headers['x-idempotency-key'] || req.headers['idempotency-key']) as string | undefined;
    if (clientKey) {
      await storeClientIdempotencyKey(clientKey, activityData);
    }

    // Match segments asynchronously
    matchActivityToSegments(activity.id, filteredPoints, activityType, bbox).catch(err => {
      logError(log, err as ErrorWithCode, 'Segment matching error', { activityId: activity.id });
    });

    // Check for achievements
    checkAchievements(userId, {
      id: activity.id,
      user_id: activity.user_id,
      type: activity.type,
      name: activity.name,
      distance: activity.distance,
      elevation_gain: activity.elevation_gain
    }).catch(err => {
      logError(log, err as ErrorWithCode, 'Achievement check error', { userId, activityId: activity.id });
    });

    // Add to followers' feeds
    const fanoutStart = Date.now();
    const followersResult = await query<{ follower_id: string }>(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [userId]
    );

    const timestamp = new Date(activity.start_time).getTime();
    for (const row of followersResult.rows) {
      await addToFeed(row.follower_id, activity.id, timestamp);
    }

    // Also add to own feed
    await addToFeed(userId, activity.id, timestamp);

    // Record feed fanout duration
    const followerCount = followersResult.rows.length;
    const followerBucket = followerCount < 10 ? '0-10' : followerCount < 100 ? '10-100' : followerCount < 1000 ? '100-1000' : '1000+';
    feedFanoutDuration.observe({ follower_count_bucket: followerBucket }, (Date.now() - fanoutStart) / 1000);

    // Record upload metrics
    const uploadDuration = (Date.now() - uploadStart) / 1000;
    activityUploadDuration.observe({ type: activityType }, uploadDuration);
    activityUploadsTotal.inc({ type: activityType, status: 'success' });

    // Log warning if upload took too long
    if (uploadDuration * 1000 > alerts.activityUpload.processingTimeWarnMs) {
      log.warn({
        activityId: activity.id,
        duration: `${uploadDuration.toFixed(2)}s`,
        threshold: `${alerts.activityUpload.processingTimeWarnMs}ms`
      }, 'Activity upload exceeded processing time threshold');
    }

    res.status(201).json({ activity, gpsPointCount: filteredPoints.length });
  } catch (error) {
    activityUploadsTotal.inc({ type: 'unknown', status: 'error' });
    logError(log, error as ErrorWithCode, 'Activity upload error', { userId });
    res.status(500).json({ error: 'Failed to upload activity' });
  }
});

// Create simulated activity (for testing without GPX)
router.post('/simulate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const uploadStart = Date.now();

  try {
    const userId = req.session.userId!;
    const body = req.body as SimulateBody;
    const {
      type = 'run',
      name,
      startLat = 37.7749,
      startLng = -122.4194,
      numPoints = 100
    } = body;

    // Generate sample route
    const points = generateSampleRoute(startLat, startLng, numPoints, type);

    // Calculate metrics
    const metrics = calculateMetrics(points);

    // Generate polyline
    const polylineStr = encodePolyline(points);

    // Get bounding box
    const bbox = calculateBoundingBox(points);

    const activityName = name || `Simulated ${type.charAt(0).toUpperCase() + type.slice(1)}`;

    // Create activity record
    const activityResult = await query<ActivityRow>(
      `INSERT INTO activities (
        user_id, type, name, start_time, elapsed_time, moving_time,
        distance, elevation_gain, avg_speed, max_speed, polyline,
        start_lat, start_lng, end_lat, end_lng, privacy
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        userId,
        type,
        activityName,
        points[0].timestamp,
        metrics.elapsedTime,
        metrics.movingTime,
        metrics.distance,
        metrics.elevationGain,
        metrics.avgSpeed,
        metrics.maxSpeed,
        polylineStr,
        points[0].latitude,
        points[0].longitude,
        points[points.length - 1].latitude,
        points[points.length - 1].longitude,
        'public'
      ]
    );

    const activity = activityResult.rows[0];

    log.info({
      activityId: activity.id,
      userId,
      type,
      simulated: true
    }, 'Simulated activity created');

    // Store GPS points
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      await query(
        `INSERT INTO gps_points (activity_id, point_index, timestamp, latitude, longitude, altitude, heart_rate, cadence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [activity.id, i, pt.timestamp, pt.latitude, pt.longitude, pt.altitude, pt.heartRate, pt.cadence]
      );
    }

    // Record metrics
    activityGpsPointsTotal.inc({ type }, points.length);
    activityUploadDuration.observe({ type }, (Date.now() - uploadStart) / 1000);
    activityUploadsTotal.inc({ type, status: 'success' });

    // Match segments
    matchActivityToSegments(activity.id, points, type, bbox).catch(err => {
      logError(log, err as ErrorWithCode, 'Segment matching error', { activityId: activity.id });
    });

    // Check for achievements
    checkAchievements(userId, {
      id: activity.id,
      user_id: activity.user_id,
      type: activity.type,
      name: activity.name,
      distance: activity.distance,
      elevation_gain: activity.elevation_gain
    }).catch(err => {
      logError(log, err as ErrorWithCode, 'Achievement check error', { userId });
    });

    // Add to followers' feeds
    const followersResult = await query<{ follower_id: string }>(
      'SELECT follower_id FROM follows WHERE following_id = $1',
      [userId]
    );

    const timestamp = new Date(activity.start_time).getTime();
    for (const row of followersResult.rows) {
      await addToFeed(row.follower_id, activity.id, timestamp);
    }
    await addToFeed(userId, activity.id, timestamp);

    res.status(201).json({ activity, gpsPointCount: points.length });
  } catch (error) {
    activityUploadsTotal.inc({ type: 'unknown', status: 'error' });
    logError(log, error as ErrorWithCode, 'Simulate activity error');
    res.status(500).json({ error: 'Failed to create simulated activity' });
  }
});

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
router.get('/:id', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
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
      return res.status(404).json({ error: 'Activity not found' });
    }

    const activity = result.rows[0];

    // Check privacy
    if (activity.privacy !== 'public' && activity.user_id !== req.session?.userId) {
      // Check if viewer follows activity owner
      if (activity.privacy === 'followers' && req.session?.userId) {
        const followResult = await query<{ count: string }>(
          'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
          [req.session.userId, activity.user_id]
        );
        if (followResult.rows.length === 0) {
          return res.status(403).json({ error: 'Activity is private' });
        }
      } else {
        return res.status(403).json({ error: 'Activity is private' });
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
router.get('/:id/gps', optionalAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // First check activity exists and privacy
    const activityResult = await query<{ user_id: string; privacy: string }>(
      'SELECT user_id, privacy FROM activities WHERE id = $1',
      [id]
    );

    if (activityResult.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found' });
    }

    const activity = activityResult.rows[0];

    // Check privacy (simplified)
    if (activity.privacy !== 'public' && activity.user_id !== req.session?.userId) {
      return res.status(403).json({ error: 'Activity is private' });
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

// Give kudos to an activity
router.post('/:id/kudos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;

    await query(
      'INSERT INTO kudos (activity_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, userId]
    );

    // Update kudos count
    await query(
      'UPDATE activities SET kudos_count = (SELECT COUNT(*) FROM kudos WHERE activity_id = $1) WHERE id = $1',
      [id]
    );

    res.json({ message: 'Kudos given' });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Kudos error');
    res.status(500).json({ error: 'Failed to give kudos' });
  }
});

// Remove kudos from an activity
router.delete('/:id/kudos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;

    await query(
      'DELETE FROM kudos WHERE activity_id = $1 AND user_id = $2',
      [id, userId]
    );

    // Update kudos count
    await query(
      'UPDATE activities SET kudos_count = (SELECT COUNT(*) FROM kudos WHERE activity_id = $1) WHERE id = $1',
      [id]
    );

    res.json({ message: 'Kudos removed' });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Remove kudos error');
    res.status(500).json({ error: 'Failed to remove kudos' });
  }
});

// Add comment to an activity
router.post('/:id/comments', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;
    const { content } = req.body as { content?: string };

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const result = await query<{ id: string; content: string; created_at: Date }>(
      `INSERT INTO comments (activity_id, user_id, content) VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [id, userId, content.trim()]
    );

    // Update comment count
    await query(
      'UPDATE activities SET comment_count = (SELECT COUNT(*) FROM comments WHERE activity_id = $1) WHERE id = $1',
      [id]
    );

    res.status(201).json({ comment: result.rows[0] });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Add comment error');
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Get comments for an activity
router.get('/:id/comments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const result = await query<CommentRow>(
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

// Delete activity (owner only)
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;

    const result = await query<{ id: string }>(
      'DELETE FROM activities WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found or not owned by you' });
    }

    log.info({ activityId: id, userId }, 'Activity deleted');
    res.json({ message: 'Activity deleted' });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Delete activity error');
    res.status(500).json({ error: 'Failed to delete activity' });
  }
});

export default router;
