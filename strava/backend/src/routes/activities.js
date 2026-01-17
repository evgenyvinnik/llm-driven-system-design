import { Router } from 'express';
import multer from 'multer';
import { query } from '../utils/db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { addToFeed } from '../utils/redis.js';
import {
  parseGPX,
  calculateMetrics,
  encodePolyline,
  calculateBoundingBox,
  applyPrivacyZones,
  generateSampleRoute
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
import { activityLogger as log, logError } from '../shared/logger.js';
import { alerts, gps as gpsConfig } from '../shared/config.js';
import {
  checkIdempotency,
  storeIdempotencyKey,
  storeClientIdempotencyKey
} from '../shared/idempotency.js';

const router = Router();

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: alerts.activityUpload.maxFileSizeBytes },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/gpx+xml' || file.originalname.endsWith('.gpx')) {
      cb(null, true);
    } else {
      cb(new Error('Only GPX files are allowed'));
    }
  }
});

// Create activity from GPX upload
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  const uploadStart = Date.now();
  const userId = req.session.userId;

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
    const activityType = req.body.type || 'run';

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
    const privacyZonesResult = await query(
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

    const activityName = req.body.name || name || `${activityType.charAt(0).toUpperCase() + activityType.slice(1)} Activity`;

    // Create activity record
    const activityResult = await query(
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
        req.body.description || null,
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
        req.body.privacy || 'followers'
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
    await storeIdempotencyKey(userId, gpxContent, startTimestamp, activity);

    // Store client-provided idempotency key if present
    const clientKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'];
    if (clientKey) {
      await storeClientIdempotencyKey(clientKey, activity);
    }

    // Match segments asynchronously
    matchActivityToSegments(activity.id, filteredPoints, activityType, bbox).catch(err => {
      logError(log, err, 'Segment matching error', { activityId: activity.id });
    });

    // Check for achievements
    checkAchievements(userId, activity).catch(err => {
      logError(log, err, 'Achievement check error', { userId, activityId: activity.id });
    });

    // Add to followers' feeds
    const fanoutStart = Date.now();
    const followersResult = await query(
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
    logError(log, error, 'Activity upload error', { userId });
    res.status(500).json({ error: 'Failed to upload activity' });
  }
});

// Create simulated activity (for testing without GPX)
router.post('/simulate', requireAuth, async (req, res) => {
  const uploadStart = Date.now();

  try {
    const userId = req.session.userId;
    const {
      type = 'run',
      name,
      startLat = 37.7749,
      startLng = -122.4194,
      numPoints = 100
    } = req.body;

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
    const activityResult = await query(
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
      logError(log, err, 'Segment matching error', { activityId: activity.id });
    });

    // Check for achievements
    checkAchievements(userId, activity).catch(err => {
      logError(log, err, 'Achievement check error', { userId });
    });

    // Add to followers' feeds
    const followersResult = await query(
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
    logError(log, error, 'Simulate activity error');
    res.status(500).json({ error: 'Failed to create simulated activity' });
  }
});

// Get all activities (paginated)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type;
    const userId = req.query.userId;

    let whereClause = "WHERE a.privacy = 'public'";
    const params = [];
    let paramIndex = 1;

    if (type) {
      whereClause += ` AND a.type = $${paramIndex++}`;
      params.push(type);
    }

    if (userId) {
      whereClause += ` AND a.user_id = $${paramIndex++}`;
      params.push(userId);
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
    logError(log, error, 'Get activities error');
    res.status(500).json({ error: 'Failed to get activities' });
  }
});

// Get single activity
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
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
        const followResult = await query(
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
    const kudosResult = await query(
      'SELECT COUNT(*) FROM kudos WHERE activity_id = $1',
      [id]
    );

    // Check if current user has given kudos
    let hasKudos = false;
    if (req.session?.userId) {
      const userKudosResult = await query(
        'SELECT 1 FROM kudos WHERE activity_id = $1 AND user_id = $2',
        [id, req.session.userId]
      );
      hasKudos = userKudosResult.rows.length > 0;
    }

    // Get segment efforts for this activity
    const effortsResult = await query(
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
    logError(log, error, 'Get activity error');
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// Get GPS points for activity
router.get('/:id/gps', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // First check activity exists and privacy
    const activityResult = await query(
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

    const result = await query(
      `SELECT point_index, timestamp, latitude, longitude, altitude, speed, heart_rate, cadence, power
       FROM gps_points
       WHERE activity_id = $1
       ORDER BY point_index`,
      [id]
    );

    res.json({ points: result.rows });
  } catch (error) {
    logError(log, error, 'Get GPS points error');
    res.status(500).json({ error: 'Failed to get GPS points' });
  }
});

// Give kudos to an activity
router.post('/:id/kudos', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

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
    logError(log, error, 'Kudos error');
    res.status(500).json({ error: 'Failed to give kudos' });
  }
});

// Remove kudos from an activity
router.delete('/:id/kudos', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

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
    logError(log, error, 'Remove kudos error');
    res.status(500).json({ error: 'Failed to remove kudos' });
  }
});

// Add comment to an activity
router.post('/:id/comments', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const result = await query(
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
    logError(log, error, 'Add comment error');
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Get comments for an activity
router.get('/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT c.id, c.content, c.created_at, u.id as user_id, u.username, u.profile_photo
       FROM comments c
       JOIN users u ON c.user_id = u.id
       WHERE c.activity_id = $1
       ORDER BY c.created_at ASC`,
      [id]
    );

    res.json({ comments: result.rows });
  } catch (error) {
    logError(log, error, 'Get comments error');
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// Delete activity (owner only)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    const result = await query(
      'DELETE FROM activities WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activity not found or not owned by you' });
    }

    log.info({ activityId: id, userId }, 'Activity deleted');
    res.json({ message: 'Activity deleted' });
  } catch (error) {
    logError(log, error, 'Delete activity error');
    res.status(500).json({ error: 'Failed to delete activity' });
  }
});

export default router;
