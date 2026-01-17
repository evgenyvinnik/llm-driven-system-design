/**
 * Canvas service for managing the collaborative pixel canvas.
 *
 * Handles all canvas operations including:
 * - Canvas initialization and state retrieval
 * - Pixel placement with rate limiting and idempotency
 * - Event logging to PostgreSQL
 * - Snapshot creation for timelapse
 * - Historical canvas reconstruction
 *
 * Includes circuit breaker protection for Redis operations.
 */
import { redis, redisPub } from './redis.js';
import { query } from './database.js';
import zlib from 'zlib';
import { promisify } from 'util';
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  CANVAS_SIZE,
  COOLDOWN_SECONDS,
  VALID_COLORS,
  REDIS_KEYS,
} from '../config.js';
import { logger, logPixelPlacement, logRateLimitHit } from '../shared/logger.js';
import {
  pixelsPlacedTotal,
  rateLimitHitsTotal,
  pixelPlacementDuration,
  redisOperationsTotal,
  redisOperationDuration,
  activeUsers,
} from '../shared/metrics.js';
import { withCircuitBreaker } from '../shared/circuitBreaker.js';
import { generateIdempotencyKey, withIdempotency } from '../shared/idempotency.js';
import type { PixelEvent, CooldownStatus } from '../types/index.js';

/** Promisified gzip compression function. */
const gzipAsync = promisify(zlib.gzip);

/**
 * Tracks active users for metrics (placed pixel in last 5 minutes).
 * Map of userId to last placement timestamp.
 */
const activeUserTracker = new Map<string, number>();

/**
 * Clean up old entries from activeUserTracker every minute.
 */
setInterval(() => {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [userId, timestamp] of activeUserTracker) {
    if (timestamp < fiveMinutesAgo) {
      activeUserTracker.delete(userId);
    }
  }
  activeUsers.set(activeUserTracker.size);
}, 60000);

/**
 * Circuit breaker protected Redis operations.
 */
const protectedRedisOps = {
  getCanvas: withCircuitBreaker(
    'redis-getCanvas',
    async () => redis.getBuffer(REDIS_KEYS.CANVAS),
    null
  ),
  setCanvas: withCircuitBreaker(
    'redis-setCanvas',
    async (canvas: Buffer) => redis.set(REDIS_KEYS.CANVAS, canvas),
    'OK'
  ),
  getCooldown: withCircuitBreaker(
    'redis-getCooldown',
    async (key: string) => redis.get(key),
    null
  ),
  getTtl: withCircuitBreaker(
    'redis-getTtl',
    async (key: string) => redis.ttl(key),
    0
  ),
  setCooldown: withCircuitBreaker(
    'redis-setCooldown',
    async (key: string, value: string, seconds: number) =>
      redis.set(key, value, 'EX', seconds),
    'OK'
  ),
  setRange: withCircuitBreaker(
    'redis-setRange',
    async (offset: number, value: string) =>
      redis.setrange(REDIS_KEYS.CANVAS, offset, value),
    0
  ),
  publish: withCircuitBreaker(
    'redis-publish',
    async (message: string) => redisPub.publish(REDIS_KEYS.PIXEL_CHANNEL, message),
    0
  ),
};

/**
 * Service class managing all canvas-related operations.
 * Uses Redis for real-time state and PostgreSQL for historical data.
 */
export class CanvasService {
  /**
   * Initializes the canvas in Redis if it does not exist.
   * Creates a blank canvas with all pixels set to white (color index 0).
   */
  async initializeCanvas(): Promise<void> {
    const start = Date.now();
    try {
      const exists = await redis.exists(REDIS_KEYS.CANVAS);
      redisOperationsTotal.inc({ operation: 'exists', status: 'success' });

      if (!exists) {
        const emptyCanvas = Buffer.alloc(CANVAS_SIZE, 0);
        await protectedRedisOps.setCanvas.fire(emptyCanvas);
        redisOperationsTotal.inc({ operation: 'set', status: 'success' });
        logger.info({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, 'Canvas initialized');
      } else {
        logger.info('Canvas already exists in Redis');
      }
    } catch (error) {
      redisOperationsTotal.inc({ operation: 'init', status: 'error' });
      logger.error({ error }, 'Failed to initialize canvas');
      throw error;
    } finally {
      redisOperationDuration.observe({ operation: 'init' }, (Date.now() - start) / 1000);
    }
  }

  /**
   * Retrieves the current canvas state from Redis.
   * Creates an empty canvas if none exists.
   *
   * @returns Buffer containing color indices for all pixels (row-major order).
   */
  async getCanvas(): Promise<Buffer> {
    const start = Date.now();
    try {
      const canvas = await protectedRedisOps.getCanvas.fire();
      redisOperationsTotal.inc({ operation: 'get', status: 'success' });

      if (!canvas) {
        const emptyCanvas = Buffer.alloc(CANVAS_SIZE, 0);
        await protectedRedisOps.setCanvas.fire(emptyCanvas);
        redisOperationsTotal.inc({ operation: 'set', status: 'success' });
        return emptyCanvas;
      }
      return canvas;
    } catch (error) {
      redisOperationsTotal.inc({ operation: 'get', status: 'error' });
      logger.error({ error }, 'Failed to get canvas');
      throw error;
    } finally {
      redisOperationDuration.observe({ operation: 'getCanvas' }, (Date.now() - start) / 1000);
    }
  }

  /**
   * Retrieves the canvas as a base64-encoded string for network transmission.
   *
   * @returns Base64-encoded string of the canvas data.
   */
  async getCanvasBase64(): Promise<string> {
    const canvas = await this.getCanvas();
    return canvas.toString('base64');
  }

  /**
   * Checks the cooldown status for a user.
   *
   * @param userId - The user's unique identifier.
   * @returns CooldownStatus indicating if the user can place a pixel.
   */
  async checkCooldown(userId: string): Promise<CooldownStatus> {
    const start = Date.now();
    const cooldownKey = REDIS_KEYS.COOLDOWN(userId);

    try {
      const ttl = await protectedRedisOps.getTtl.fire(cooldownKey);
      redisOperationsTotal.inc({ operation: 'ttl', status: 'success' });

      if (ttl > 0) {
        return { canPlace: false, remainingSeconds: ttl };
      }

      return { canPlace: true, remainingSeconds: 0 };
    } catch (error) {
      redisOperationsTotal.inc({ operation: 'ttl', status: 'error' });
      logger.error({ error, userId }, 'Failed to check cooldown');
      // Fail open: allow placement if we can't check cooldown
      return { canPlace: true, remainingSeconds: 0 };
    } finally {
      redisOperationDuration.observe({ operation: 'checkCooldown' }, (Date.now() - start) / 1000);
    }
  }

  /**
   * Sets the cooldown timer for a user after placing a pixel.
   *
   * @param userId - The user's unique identifier.
   */
  async setCooldown(userId: string): Promise<void> {
    const start = Date.now();
    const cooldownKey = REDIS_KEYS.COOLDOWN(userId);

    try {
      await protectedRedisOps.setCooldown.fire(cooldownKey, Date.now().toString(), COOLDOWN_SECONDS);
      redisOperationsTotal.inc({ operation: 'set', status: 'success' });
    } catch (error) {
      redisOperationsTotal.inc({ operation: 'set', status: 'error' });
      logger.error({ error, userId }, 'Failed to set cooldown');
    } finally {
      redisOperationDuration.observe({ operation: 'setCooldown' }, (Date.now() - start) / 1000);
    }
  }

  /**
   * Places a pixel on the canvas with validation, rate limiting, and idempotency.
   *
   * Performs:
   * - Coordinate and color validation
   * - Idempotency check to prevent duplicate placements
   * - Cooldown check with rate limiting
   * - Atomic canvas update in Redis
   * - Pub/sub broadcast for real-time sync
   * - Event logging to PostgreSQL
   *
   * @param userId - The user placing the pixel.
   * @param x - X coordinate (0 to CANVAS_WIDTH-1).
   * @param y - Y coordinate (0 to CANVAS_HEIGHT-1).
   * @param color - Color index (0 to 15).
   * @param requestId - Optional client-provided request ID for idempotency.
   * @returns Object with success status, error message, and next placement time.
   */
  async placePixel(
    userId: string,
    x: number,
    y: number,
    color: number,
    requestId?: string
  ): Promise<{ success: boolean; error?: string; nextPlacement?: number }> {
    const startTime = Date.now();

    // Validate coordinates
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
      return { success: false, error: 'Invalid coordinates' };
    }

    // Validate color
    if (!VALID_COLORS.includes(color)) {
      return { success: false, error: 'Invalid color' };
    }

    // Generate idempotency key
    const idempotencyKey = generateIdempotencyKey(userId, x, y, color, requestId);

    // Execute with idempotency protection
    return withIdempotency(idempotencyKey, async () => {
      // Check cooldown (rate limiting)
      const cooldownKey = REDIS_KEYS.COOLDOWN(userId);
      const existingCooldown = await protectedRedisOps.getCooldown.fire(cooldownKey);

      if (existingCooldown) {
        const ttl = await protectedRedisOps.getTtl.fire(cooldownKey);
        rateLimitHitsTotal.inc();

        logRateLimitHit({
          userId,
          remainingSeconds: ttl,
        });

        return {
          success: false,
          error: `Rate limited. Wait ${ttl} seconds.`,
          nextPlacement: Date.now() + ttl * 1000,
        };
      }

      // Calculate offset in canvas buffer
      const offset = y * CANVAS_WIDTH + x;

      // Update canvas in Redis (atomic operation)
      const colorByte = Buffer.from([color]);
      await protectedRedisOps.setRange.fire(offset, colorByte.toString('binary'));
      redisOperationsTotal.inc({ operation: 'setrange', status: 'success' });

      // Set cooldown
      await protectedRedisOps.setCooldown.fire(cooldownKey, Date.now().toString(), COOLDOWN_SECONDS);

      // Create pixel event
      const event: PixelEvent = {
        x,
        y,
        color,
        userId,
        timestamp: Date.now(),
      };

      // Publish to Redis pub/sub for real-time updates
      await protectedRedisOps.publish.fire(JSON.stringify(event));
      redisOperationsTotal.inc({ operation: 'publish', status: 'success' });

      // Log to PostgreSQL for history (async, non-blocking)
      this.logPixelEvent(event).catch((error) => {
        logger.error({ error, event }, 'Failed to log pixel event to PostgreSQL');
      });

      // Update metrics
      const duration = Date.now() - startTime;
      pixelsPlacedTotal.inc({ color: color.toString() });
      pixelPlacementDuration.observe(duration / 1000);

      // Track active user
      activeUserTracker.set(userId, Date.now());
      activeUsers.set(activeUserTracker.size);

      // Log placement
      logPixelPlacement({
        userId,
        x,
        y,
        color,
        latencyMs: duration,
      });

      return {
        success: true,
        nextPlacement: Date.now() + COOLDOWN_SECONDS * 1000,
      };
    });
  }

  /**
   * Logs a pixel placement event to PostgreSQL for historical records.
   *
   * @param event - The pixel event to log.
   */
  private async logPixelEvent(event: PixelEvent): Promise<void> {
    try {
      await query(
        `INSERT INTO pixel_events (x, y, color, user_id, placed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [event.x, event.y, event.color, event.userId, new Date(event.timestamp)]
      );
    } catch (error) {
      logger.error({ error, event }, 'Failed to log pixel event');
    }
  }

  /**
   * Creates a compressed snapshot of the current canvas state.
   * Snapshots are stored in PostgreSQL and used for timelapse generation.
   */
  async createSnapshot(): Promise<void> {
    try {
      const canvas = await this.getCanvas();
      const compressed = await gzipAsync(canvas);

      // Get total pixel count
      const countResult = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM pixel_events'
      );
      const pixelCount = parseInt(countResult[0]?.count || '0');

      await query(
        `INSERT INTO canvas_snapshots (canvas_data, pixel_count) VALUES ($1, $2)`,
        [compressed, pixelCount]
      );

      logger.info({ pixelCount }, 'Canvas snapshot created');
    } catch (error) {
      logger.error({ error }, 'Failed to create snapshot');
    }
  }

  /**
   * Reconstructs the canvas state at a specific point in time.
   * Uses the nearest snapshot and replays subsequent events.
   *
   * @param targetTime - The timestamp to reconstruct the canvas for.
   * @returns Buffer containing the canvas state, or null if no data available.
   */
  async getCanvasAtTime(targetTime: Date): Promise<Buffer | null> {
    try {
      // Find the most recent snapshot before target time
      const snapshots = await query<{ canvas_data: Buffer; captured_at: Date }>(
        `SELECT canvas_data, captured_at FROM canvas_snapshots
         WHERE captured_at <= $1
         ORDER BY captured_at DESC
         LIMIT 1`,
        [targetTime]
      );

      if (snapshots.length === 0) {
        return null;
      }

      const snapshot = snapshots[0];
      const gunzipAsync = promisify(zlib.gunzip);
      const canvas = await gunzipAsync(snapshot.canvas_data);

      // Replay events from snapshot to target time
      const events = await query<{ x: number; y: number; color: number }>(
        `SELECT x, y, color FROM pixel_events
         WHERE placed_at > $1 AND placed_at <= $2
         ORDER BY placed_at ASC`,
        [snapshot.captured_at, targetTime]
      );

      const canvasBuffer = Buffer.from(canvas);
      for (const event of events) {
        const offset = event.y * CANVAS_WIDTH + event.x;
        canvasBuffer[offset] = event.color;
      }

      return canvasBuffer;
    } catch (error) {
      logger.error({ error }, 'Failed to get canvas at time');
      return null;
    }
  }

  /**
   * Generates timelapse frames showing canvas evolution over time.
   *
   * @param startTime - Beginning of the timelapse period.
   * @param endTime - End of the timelapse period.
   * @param frameCount - Number of frames to generate.
   * @returns Array of frames with timestamp and base64-encoded canvas data.
   */
  async getTimelapseFrames(
    startTime: Date,
    endTime: Date,
    frameCount: number
  ): Promise<{ timestamp: Date; canvas: string }[]> {
    const frames: { timestamp: Date; canvas: string }[] = [];
    const interval = (endTime.getTime() - startTime.getTime()) / frameCount;

    for (let i = 0; i < frameCount; i++) {
      const timestamp = new Date(startTime.getTime() + interval * i);
      const canvas = await this.getCanvasAtTime(timestamp);
      if (canvas) {
        frames.push({
          timestamp,
          canvas: canvas.toString('base64'),
        });
      }
    }

    return frames;
  }

  /**
   * Retrieves recent pixel placement events.
   *
   * @param limit - Maximum number of events to return (default 100).
   * @returns Array of pixel events sorted by most recent first.
   */
  async getRecentEvents(limit: number = 100): Promise<PixelEvent[]> {
    const events = await query<{
      x: number;
      y: number;
      color: number;
      user_id: string;
      placed_at: Date;
    }>(
      `SELECT x, y, color, user_id, placed_at
       FROM pixel_events
       ORDER BY placed_at DESC
       LIMIT $1`,
      [limit]
    );

    return events.map((e) => ({
      x: e.x,
      y: e.y,
      color: e.color,
      userId: e.user_id,
      timestamp: e.placed_at.getTime(),
    }));
  }

  /**
   * Retrieves the placement history for a specific pixel location.
   *
   * @param x - X coordinate of the pixel.
   * @param y - Y coordinate of the pixel.
   * @param limit - Maximum number of events to return (default 50).
   * @returns Array of pixel events for this location, most recent first.
   */
  async getPixelHistory(
    x: number,
    y: number,
    limit: number = 50
  ): Promise<PixelEvent[]> {
    const events = await query<{
      x: number;
      y: number;
      color: number;
      user_id: string;
      placed_at: Date;
    }>(
      `SELECT x, y, color, user_id, placed_at
       FROM pixel_events
       WHERE x = $1 AND y = $2
       ORDER BY placed_at DESC
       LIMIT $3`,
      [x, y, limit]
    );

    return events.map((e) => ({
      x: e.x,
      y: e.y,
      color: e.color,
      userId: e.user_id,
      timestamp: e.placed_at.getTime(),
    }));
  }
}

/** Singleton instance of the canvas service. */
export const canvasService = new CanvasService();
