import { query } from '../utils/db.js';
import { updateLeaderboard } from '../utils/redis.js';
import { haversineDistance, decodePolyline, encodePolyline, calculateBoundingBox, GpsPoint, BoundingBox } from '../utils/gps.js';

const DISTANCE_THRESHOLD = 25; // meters - max deviation from segment

export interface Segment {
  id: string;
  name: string;
  polyline: string;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  distance: number;
}

export interface SegmentEffort {
  id: string;
  segment_id: string;
  activity_id: string;
  user_id: string;
  elapsed_time: number;
  moving_time: number;
  start_index: number;
  end_index: number;
  pr_rank?: number;
}

interface MatchResult {
  isMatch: boolean;
  pointsUsed?: number;
  maxDeviation?: number;
}

interface EffortData {
  startIndex: number;
  endIndex: number;
  elapsedTime: number;
  movingTime: number;
}

/**
 * Match an activity against all relevant segments
 */
export async function matchActivityToSegments(
  activityId: string,
  gpsPoints: GpsPoint[],
  activityType: string,
  bbox: BoundingBox | null
): Promise<SegmentEffort[]> {
  if (!gpsPoints || gpsPoints.length < 10) {
    return [];
  }

  // Phase 1: Find candidate segments using bounding box intersection
  const candidates = await findCandidateSegments(bbox, activityType);

  if (candidates.length === 0) {
    return [];
  }

  console.log(`Found ${candidates.length} candidate segments for activity ${activityId}`);

  const matchedEfforts: SegmentEffort[] = [];

  // Phase 2: Fine match each candidate
  for (const segment of candidates) {
    const effort = matchSegmentToActivity(segment, gpsPoints);

    if (effort) {
      // Save effort to database
      const savedEffort = await saveSegmentEffort(activityId, segment.id, effort);
      matchedEfforts.push(savedEffort);

      // Update leaderboard
      const result = await query<{ user_id: string }>(
        'SELECT user_id FROM activities WHERE id = $1',
        [activityId]
      );
      if (result.rows.length > 0) {
        const userId = result.rows[0].user_id;
        const { isPR, rank } = await updateLeaderboard(segment.id, userId, effort.elapsedTime);

        if (isPR && rank !== null && rank <= 3) {
          // Update PR rank in segment effort
          await query(
            'UPDATE segment_efforts SET pr_rank = $1 WHERE id = $2',
            [rank, savedEffort.id]
          );
        }

        // Update segment stats
        await query(
          `UPDATE segments SET
            effort_count = effort_count + 1,
            athlete_count = (SELECT COUNT(DISTINCT user_id) FROM segment_efforts WHERE segment_id = $1)
           WHERE id = $1`,
          [segment.id]
        );
      }
    }
  }

  console.log(`Matched ${matchedEfforts.length} segment efforts for activity ${activityId}`);
  return matchedEfforts;
}

/**
 * Find segments whose bounding boxes intersect with activity bounding box
 */
async function findCandidateSegments(
  bbox: BoundingBox | null,
  activityType: string
): Promise<Segment[]> {
  if (!bbox) return [];

  // Add a small buffer to the bounding box (about 100 meters)
  const buffer = 0.001; // roughly 100m

  const result = await query<Segment>(
    `SELECT id, name, polyline, start_lat, start_lng, end_lat, end_lng, distance
     FROM segments
     WHERE activity_type = $1
       AND min_lat <= $2 + $5
       AND max_lat >= $3 - $5
       AND min_lng <= $4 + $5
       AND max_lng >= $6 - $5`,
    [activityType, bbox.maxLat, bbox.minLat, bbox.maxLng, buffer, bbox.minLng]
  );

  return result.rows;
}

/**
 * Match a single segment against activity GPS points
 * Returns effort data if matched, null otherwise
 */
function matchSegmentToActivity(segment: Segment, activityPoints: GpsPoint[]): EffortData | null {
  const segmentPoints = decodePolyline(segment.polyline);

  if (segmentPoints.length < 2) {
    return null;
  }

  const segmentStart = segmentPoints[0];

  // Find activity points near segment start
  const startCandidates = findPointsNear(activityPoints, segmentStart, DISTANCE_THRESHOLD);

  for (const startIdx of startCandidates) {
    // Try to match segment from this starting point
    const matchResult = tryMatchFromPoint(
      activityPoints.slice(startIdx),
      segmentPoints
    );

    if (matchResult.isMatch && matchResult.pointsUsed !== undefined) {
      const endIdx = startIdx + matchResult.pointsUsed;

      // Calculate elapsed time
      const startTime = activityPoints[startIdx].timestamp;
      const endTime = activityPoints[Math.min(endIdx, activityPoints.length - 1)].timestamp;

      let elapsedTime = 0;
      if (startTime && endTime) {
        elapsedTime = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
      }

      // Calculate moving time (exclude stops)
      let movingTime = 0;
      for (let i = startIdx; i < Math.min(endIdx, activityPoints.length - 1); i++) {
        const curr = activityPoints[i];
        const next = activityPoints[i + 1];
        if (curr.timestamp && next.timestamp) {
          const timeDiff = (next.timestamp.getTime() - curr.timestamp.getTime()) / 1000;
          const dist = haversineDistance(
            curr.latitude, curr.longitude,
            next.latitude, next.longitude
          );
          const speed = timeDiff > 0 ? dist / timeDiff : 0;
          if (speed > 0.5) { // Moving threshold
            movingTime += timeDiff;
          }
        }
      }

      return {
        startIndex: startIdx,
        endIndex: endIdx,
        elapsedTime,
        movingTime: Math.round(movingTime)
      };
    }
  }

  return null;
}

/**
 * Find indices of points near a target location
 */
function findPointsNear(points: GpsPoint[], target: GpsPoint, maxDistance: number): number[] {
  const indices: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const distance = haversineDistance(
      points[i].latitude, points[i].longitude,
      target.latitude, target.longitude
    );
    if (distance <= maxDistance) {
      indices.push(i);
    }
  }

  return indices;
}

/**
 * Try to match activity points against segment points
 */
function tryMatchFromPoint(activityPoints: GpsPoint[], segmentPoints: GpsPoint[]): MatchResult {
  let activityIdx = 0;
  let segmentIdx = 0;
  let maxDeviation = 0;

  while (segmentIdx < segmentPoints.length && activityIdx < activityPoints.length) {
    const segPoint = segmentPoints[segmentIdx];
    const actPoint = activityPoints[activityIdx];

    const distance = haversineDistance(
      segPoint.latitude, segPoint.longitude,
      actPoint.latitude, actPoint.longitude
    );

    if (distance > DISTANCE_THRESHOLD * 2) {
      // Too far off the segment
      return { isMatch: false };
    }

    maxDeviation = Math.max(maxDeviation, distance);

    // Advance the pointer that is behind
    if (shouldAdvanceActivity(activityPoints, segmentPoints, activityIdx, segmentIdx)) {
      activityIdx++;
    } else {
      segmentIdx++;
    }
  }

  // Check if we covered most of the segment
  if (segmentIdx >= segmentPoints.length - 1) {
    return { isMatch: true, pointsUsed: activityIdx, maxDeviation };
  }

  return { isMatch: false };
}

/**
 * Determine which pointer to advance based on relative positions
 */
function shouldAdvanceActivity(
  activityPoints: GpsPoint[],
  segmentPoints: GpsPoint[],
  activityIdx: number,
  segmentIdx: number
): boolean {
  if (activityIdx >= activityPoints.length - 1) return false;
  if (segmentIdx >= segmentPoints.length - 1) return true;

  const nextSeg = segmentPoints[segmentIdx + 1];
  const currAct = activityPoints[activityIdx];
  const nextAct = activityPoints[activityIdx + 1];

  const distCurrToNextSeg = haversineDistance(
    currAct.latitude, currAct.longitude,
    nextSeg.latitude, nextSeg.longitude
  );

  const distNextToNextSeg = haversineDistance(
    nextAct.latitude, nextAct.longitude,
    nextSeg.latitude, nextSeg.longitude
  );

  return distNextToNextSeg < distCurrToNextSeg;
}

/**
 * Save segment effort to database
 */
async function saveSegmentEffort(
  activityId: string,
  segmentId: string,
  effort: EffortData
): Promise<SegmentEffort> {
  // Get user_id from activity
  const activityResult = await query<{ user_id: string }>(
    'SELECT user_id FROM activities WHERE id = $1',
    [activityId]
  );

  if (activityResult.rows.length === 0) {
    throw new Error('Activity not found');
  }

  const userId = activityResult.rows[0].user_id;

  const result = await query<SegmentEffort>(
    `INSERT INTO segment_efforts (segment_id, activity_id, user_id, elapsed_time, moving_time, start_index, end_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [segmentId, activityId, userId, effort.elapsedTime, effort.movingTime, effort.startIndex, effort.endIndex]
  );

  return result.rows[0];
}

interface GpsPointRow {
  latitude: number;
  longitude: number;
  altitude: number | null;
}

interface ActivityTypeRow {
  type: string;
}

interface SegmentRow {
  id: string;
  creator_id: string;
  name: string;
  activity_type: string;
  distance: number;
  elevation_gain: number;
  polyline: string;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
}

/**
 * Create a segment from activity GPS points
 */
export async function createSegmentFromActivity(
  activityId: string,
  startIndex: number,
  endIndex: number,
  name: string,
  userId: string
): Promise<SegmentRow> {
  // Get GPS points for the specified range
  const pointsResult = await query<GpsPointRow>(
    `SELECT latitude, longitude, altitude
     FROM gps_points
     WHERE activity_id = $1 AND point_index >= $2 AND point_index <= $3
     ORDER BY point_index`,
    [activityId, startIndex, endIndex]
  );

  if (pointsResult.rows.length < 2) {
    throw new Error('Not enough GPS points for segment');
  }

  // Get activity type
  const activityResult = await query<ActivityTypeRow>(
    'SELECT type FROM activities WHERE id = $1',
    [activityId]
  );

  const activityType = activityResult.rows[0].type;
  const points: GpsPoint[] = pointsResult.rows.map(row => ({
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: row.altitude,
    timestamp: null
  }));

  // Calculate segment metrics
  let distance = 0;
  let elevationGain = 0;

  for (let i = 1; i < points.length; i++) {
    distance += haversineDistance(
      points[i - 1].latitude, points[i - 1].longitude,
      points[i].latitude, points[i].longitude
    );

    if (points[i].altitude && points[i - 1].altitude) {
      const elevDiff = points[i].altitude - points[i - 1].altitude;
      if (elevDiff > 0) {
        elevationGain += elevDiff;
      }
    }
  }

  // Create polyline
  const polylineStr = encodePolyline(points);
  const bbox = calculateBoundingBox(points);

  if (!bbox) {
    throw new Error('Could not calculate bounding box');
  }

  // Save segment
  const result = await query<SegmentRow>(
    `INSERT INTO segments (
      creator_id, name, activity_type, distance, elevation_gain, polyline,
      start_lat, start_lng, end_lat, end_lng,
      min_lat, min_lng, max_lat, max_lng
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      userId,
      name,
      activityType,
      distance,
      elevationGain,
      polylineStr,
      points[0].latitude,
      points[0].longitude,
      points[points.length - 1].latitude,
      points[points.length - 1].longitude,
      bbox.minLat,
      bbox.minLng,
      bbox.maxLat,
      bbox.maxLng
    ]
  );

  return result.rows[0];
}
