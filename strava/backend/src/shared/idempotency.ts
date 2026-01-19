/**
 * Idempotency service for activity uploads
 *
 * Prevents duplicate activity uploads by:
 * 1. Hashing GPX content + user ID + timestamp
 * 2. Storing idempotency keys in Redis with TTL
 * 3. Returning cached activity if duplicate detected
 *
 * WHY: GPS devices may sync the same activity multiple times due to:
 * - Network failures during upload
 * - User retry clicks
 * - Device firmware issues
 * - App crashes mid-upload
 *
 * This ensures athletes never see duplicate activities in their feed.
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { getClient } from '../utils/redis.js';
import { idempotency as config } from './config.js';
import { activityIdempotencyHits } from './metrics.js';
import { logger } from './logger.js';

const log = logger.child({ component: 'idempotency' });

export interface CachedActivity {
  id: string;
  name: string;
  type: string;
  start_time?: string;
  distance?: number;
  elapsed_time?: number;
  cached: boolean;
  cached_at?: string;
}

export interface ActivityData {
  id: string;
  name: string;
  type: string;
  start_time: Date | string;
  distance: number;
  elapsed_time: number;
  [key: string]: unknown;
}

export interface IdempotentRequest extends Request {
  clientIdempotencyKey?: string;
}

/**
 * Generate idempotency key from GPX content and user
 *
 * The key is based on:
 * - User ID (same GPX can be valid for different users)
 * - GPX file content hash (primary deduplication)
 * - Start timestamp from GPX (ensures same route on different days is allowed)
 */
export function generateIdempotencyKey(
  userId: string,
  gpxContent: string,
  startTimestamp: Date | null
): string {
  const contentToHash = `${userId}:${gpxContent}:${startTimestamp?.toISOString() || ''}`;

  const hash = crypto
    .createHash(config.hashAlgorithm)
    .update(contentToHash)
    .digest('hex');

  return `${config.keyPrefix}${hash}`;
}

/**
 * Check if this activity upload is a duplicate
 *
 * @returns {CachedActivity|null} - Returns cached activity if duplicate, null if new
 */
export async function checkIdempotency(
  userId: string,
  gpxContent: string,
  startTimestamp: Date | null
): Promise<CachedActivity | null> {
  const key = generateIdempotencyKey(userId, gpxContent, startTimestamp);

  try {
    const client = getClient();
    const cached = await client.get(key);

    if (cached) {
      activityIdempotencyHits.inc();
      log.info({ userId, key: key.substring(0, 20) + '...' }, 'Idempotency hit - duplicate activity detected');

      return JSON.parse(cached);
    }

    return null;
  } catch (error) {
    // On Redis error, allow the upload to proceed
    // Better to have potential duplicates than block uploads
    const err = error as Error;
    log.warn({ error: err.message }, 'Idempotency check failed, proceeding with upload');
    return null;
  }
}

/**
 * Store idempotency key after successful activity creation
 *
 * @param {string} userId - User ID
 * @param {string} gpxContent - Raw GPX content
 * @param {Date|null} startTimestamp - Activity start timestamp
 * @param {ActivityData} activity - Created activity object
 */
export async function storeIdempotencyKey(
  userId: string,
  gpxContent: string,
  startTimestamp: Date | null,
  activity: ActivityData
): Promise<void> {
  const key = generateIdempotencyKey(userId, gpxContent, startTimestamp);

  try {
    const client = getClient();

    // Store minimal activity info for response
    const cached: CachedActivity = {
      id: activity.id,
      name: activity.name,
      type: activity.type,
      start_time: typeof activity.start_time === 'string' ? activity.start_time : activity.start_time.toISOString(),
      distance: activity.distance,
      elapsed_time: activity.elapsed_time,
      cached: true,
      cached_at: new Date().toISOString()
    };

    await client.setex(key, config.keyTTL, JSON.stringify(cached));

    log.debug({ activityId: activity.id, key: key.substring(0, 20) + '...' }, 'Stored idempotency key');
  } catch (error) {
    // Log but don't fail the upload
    const err = error as Error;
    log.warn({ error: err.message, activityId: activity.id }, 'Failed to store idempotency key');
  }
}

/**
 * Generate idempotency key for simulated activities
 * Uses different inputs since there's no GPX content
 */
export function generateSimulatedIdempotencyKey(
  userId: string,
  type: string,
  startLat: number,
  startLng: number,
  numPoints: number
): string {
  const contentToHash = `${userId}:simulated:${type}:${startLat}:${startLng}:${numPoints}:${Date.now()}`;

  const hash = crypto
    .createHash(config.hashAlgorithm)
    .update(contentToHash)
    .digest('hex');

  return `${config.keyPrefix}sim:${hash}`;
}

/**
 * Middleware for idempotent activity uploads
 *
 * Usage in route:
 * router.post('/upload', requireAuth, idempotencyMiddleware, upload.single('file'), async (req, res) => {...})
 */
export async function idempotencyMiddleware(
  req: IdempotentRequest,
  res: Response,
  next: NextFunction
): Promise<void | Response> {
  // Only apply to POST requests with files
  if (req.method !== 'POST') {
    return next();
  }

  // Check for client-provided idempotency key
  const clientKey = (req.headers['x-idempotency-key'] || req.headers['idempotency-key']) as string | undefined;

  if (clientKey) {
    try {
      const client = getClient();
      const cached = await client.get(`${config.keyPrefix}client:${clientKey}`);

      if (cached) {
        activityIdempotencyHits.inc();
        log.info({ clientKey: clientKey.substring(0, 20) + '...' }, 'Client idempotency key hit');

        const activity = JSON.parse(cached);
        return res.status(200).json({
          activity,
          duplicate: true,
          message: 'Activity already uploaded (idempotent response)'
        });
      }

      // Store the client key for later
      req.clientIdempotencyKey = clientKey;
    } catch (error) {
      const err = error as Error;
      log.warn({ error: err.message }, 'Client idempotency check failed');
    }
  }

  next();
}

/**
 * Store client-provided idempotency key after successful upload
 */
export async function storeClientIdempotencyKey(
  clientKey: string | undefined,
  activity: ActivityData
): Promise<void> {
  if (!clientKey) return;

  try {
    const client = getClient();
    const cached: CachedActivity = {
      id: activity.id,
      name: activity.name,
      type: activity.type,
      cached: true
    };

    await client.setex(`${config.keyPrefix}client:${clientKey}`, config.keyTTL, JSON.stringify(cached));
  } catch (error) {
    const err = error as Error;
    log.warn({ error: err.message }, 'Failed to store client idempotency key');
  }
}

export default {
  generateIdempotencyKey,
  checkIdempotency,
  storeIdempotencyKey,
  idempotencyMiddleware,
  storeClientIdempotencyKey
};
