import { Router, Response } from 'express';
import multer, { Multer } from 'multer';
import { query } from '../../utils/db.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  parseGPX,
  calculateMetrics,
  encodePolyline,
  calculateBoundingBox,
  applyPrivacyZones,
  PrivacyZone
} from '../../utils/gps.js';
import {
  activityUploadsTotal,
  activityUploadDuration
} from '../../shared/metrics.js';
import { activityLogger as log, logError, ErrorWithCode } from '../../shared/logger.js';
import { alerts, gps as gpsConfig } from '../../shared/config.js';
import {
  checkIdempotency,
  storeIdempotencyKey,
  storeClientIdempotencyKey,
  ActivityData
} from '../../shared/idempotency.js';
import { MulterRequest, UploadBody, ActivityRow } from './types.js';
import {
  storeGpsPoints,
  recordGpsMetric,
  triggerSegmentMatching,
  triggerAchievementCheck,
  fanoutToFollowers
} from './helpers.js';

const router = Router();

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

// Create activity from GPX upload
router.post('/upload', requireAuth, upload.single('file'), async (req: MulterRequest, res: Response): Promise<void> => {
  const uploadStart = Date.now();
  const userId = req.session.userId!;

  try {
    if (!req.file) {
      activityUploadsTotal.inc({ type: 'unknown', status: 'error_no_file' });
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const gpxContent = req.file.buffer.toString('utf-8');
    const { name, points } = parseGPX(gpxContent);

    if (!points || points.length < gpsConfig.minActivityPoints) {
      activityUploadsTotal.inc({ type: 'unknown', status: 'error_invalid_gpx' });
      res.status(400).json({ error: `GPX file must contain at least ${gpsConfig.minActivityPoints} track points` });
      return;
    }

    if (points.length > alerts.activityUpload.maxGpsPoints) {
      activityUploadsTotal.inc({ type: 'unknown', status: 'error_too_many_points' });
      res.status(400).json({
        error: `Activity has too many GPS points (${points.length}). Maximum is ${alerts.activityUpload.maxGpsPoints}.`
      });
      return;
    }

    const startTimestamp = points[0].timestamp;
    const body = req.body as UploadBody;
    const activityType = body.type || 'run';

    const existingActivity = await checkIdempotency(userId, gpxContent, startTimestamp);
    if (existingActivity) {
      log.info({ userId, existingActivityId: existingActivity.id }, 'Duplicate activity upload detected');
      res.status(200).json({
        activity: existingActivity,
        duplicate: true,
        message: 'Activity already uploaded'
      });
      return;
    }

    const privacyZonesResult = await query<PrivacyZone>(
      'SELECT center_lat as "centerLat", center_lng as "centerLng", radius_meters as "radiusMeters" FROM privacy_zones WHERE user_id = $1',
      [userId]
    );

    const filteredPoints = applyPrivacyZones(points, privacyZonesResult.rows);
    const metrics = calculateMetrics(filteredPoints);
    const polylineStr = encodePolyline(filteredPoints);
    const bbox = calculateBoundingBox(filteredPoints);

    const activityName = body.name || name || `${activityType.charAt(0).toUpperCase() + activityType.slice(1)} Activity`;

    const activityResult = await query<ActivityRow>(
      `INSERT INTO activities (
        user_id, type, name, description, start_time, elapsed_time, moving_time,
        distance, elevation_gain, avg_speed, max_speed, polyline,
        start_lat, start_lng, end_lat, end_lng, privacy
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        userId, activityType, activityName, body.description || null,
        filteredPoints[0].timestamp || new Date(), metrics.elapsedTime, metrics.movingTime,
        metrics.distance, metrics.elevationGain, metrics.avgSpeed, metrics.maxSpeed,
        polylineStr, filteredPoints[0].latitude, filteredPoints[0].longitude,
        filteredPoints[filteredPoints.length - 1].latitude, filteredPoints[filteredPoints.length - 1].longitude,
        body.privacy || 'followers'
      ]
    );

    const activity = activityResult.rows[0];
    log.info({ activityId: activity.id, userId, type: activityType, distance: metrics.distance, gpsPoints: filteredPoints.length }, 'Activity created');

    await storeGpsPoints(activity.id, filteredPoints);
    recordGpsMetric(activityType, filteredPoints.length);

    const activityData: ActivityData = {
      id: activity.id, name: activity.name, type: activity.type,
      start_time: activity.start_time, distance: activity.distance, elapsed_time: activity.elapsed_time
    };
    await storeIdempotencyKey(userId, gpxContent, startTimestamp, activityData);

    const clientKey = (req.headers['x-idempotency-key'] || req.headers['idempotency-key']) as string | undefined;
    if (clientKey) {
      await storeClientIdempotencyKey(clientKey, activityData);
    }

    triggerSegmentMatching(activity.id, filteredPoints, activityType, bbox);
    triggerAchievementCheck(userId, activity);
    await fanoutToFollowers(userId, activity.id, activity.start_time);

    const uploadDuration = (Date.now() - uploadStart) / 1000;
    activityUploadDuration.observe({ type: activityType }, uploadDuration);
    activityUploadsTotal.inc({ type: activityType, status: 'success' });

    if (uploadDuration * 1000 > alerts.activityUpload.processingTimeWarnMs) {
      log.warn({
        activityId: activity.id, duration: `${uploadDuration.toFixed(2)}s`,
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

export default router;
