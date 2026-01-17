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
import type { PixelEvent, CooldownStatus } from '../types/index.js';

const gzipAsync = promisify(zlib.gzip);

export class CanvasService {
  // Initialize canvas with default color (white = 0)
  async initializeCanvas(): Promise<void> {
    const exists = await redis.exists(REDIS_KEYS.CANVAS);
    if (!exists) {
      const emptyCanvas = Buffer.alloc(CANVAS_SIZE, 0);
      await redis.set(REDIS_KEYS.CANVAS, emptyCanvas);
      console.log(`Canvas initialized: ${CANVAS_WIDTH}x${CANVAS_HEIGHT}`);
    } else {
      console.log('Canvas already exists in Redis');
    }
  }

  // Get entire canvas state as Buffer
  async getCanvas(): Promise<Buffer> {
    const canvas = await redis.getBuffer(REDIS_KEYS.CANVAS);
    if (!canvas) {
      const emptyCanvas = Buffer.alloc(CANVAS_SIZE, 0);
      await redis.set(REDIS_KEYS.CANVAS, emptyCanvas);
      return emptyCanvas;
    }
    return canvas;
  }

  // Get canvas as base64 string for transmission
  async getCanvasBase64(): Promise<string> {
    const canvas = await this.getCanvas();
    return canvas.toString('base64');
  }

  // Check and set cooldown for a user
  async checkCooldown(userId: string): Promise<CooldownStatus> {
    const cooldownKey = REDIS_KEYS.COOLDOWN(userId);
    const ttl = await redis.ttl(cooldownKey);

    if (ttl > 0) {
      return { canPlace: false, remainingSeconds: ttl };
    }

    return { canPlace: true, remainingSeconds: 0 };
  }

  // Set cooldown for a user
  async setCooldown(userId: string): Promise<void> {
    const cooldownKey = REDIS_KEYS.COOLDOWN(userId);
    await redis.set(cooldownKey, Date.now().toString(), 'EX', COOLDOWN_SECONDS);
  }

  // Place a pixel on the canvas
  async placePixel(
    userId: string,
    x: number,
    y: number,
    color: number
  ): Promise<{ success: boolean; error?: string; nextPlacement?: number }> {
    // Validate coordinates
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
      return { success: false, error: 'Invalid coordinates' };
    }

    // Validate color
    if (!VALID_COLORS.includes(color)) {
      return { success: false, error: 'Invalid color' };
    }

    // Check cooldown
    const cooldownKey = REDIS_KEYS.COOLDOWN(userId);
    const existingCooldown = await redis.get(cooldownKey);

    if (existingCooldown) {
      const ttl = await redis.ttl(cooldownKey);
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
    await redis.setrange(REDIS_KEYS.CANVAS, offset, colorByte.toString('binary'));

    // Set cooldown
    await redis.set(cooldownKey, Date.now().toString(), 'EX', COOLDOWN_SECONDS);

    // Create pixel event
    const event: PixelEvent = {
      x,
      y,
      color,
      userId,
      timestamp: Date.now(),
    };

    // Publish to Redis pub/sub for real-time updates
    await redisPub.publish(REDIS_KEYS.PIXEL_CHANNEL, JSON.stringify(event));

    // Log to PostgreSQL for history
    await this.logPixelEvent(event);

    return {
      success: true,
      nextPlacement: Date.now() + COOLDOWN_SECONDS * 1000,
    };
  }

  // Log pixel event to PostgreSQL
  private async logPixelEvent(event: PixelEvent): Promise<void> {
    try {
      await query(
        `INSERT INTO pixel_events (x, y, color, user_id, placed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [event.x, event.y, event.color, event.userId, new Date(event.timestamp)]
      );
    } catch (error) {
      console.error('Failed to log pixel event:', error);
    }
  }

  // Create a canvas snapshot
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

      console.log(`Canvas snapshot created, pixel count: ${pixelCount}`);
    } catch (error) {
      console.error('Failed to create snapshot:', error);
    }
  }

  // Get canvas at a specific time (for timelapse)
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
      console.error('Failed to get canvas at time:', error);
      return null;
    }
  }

  // Get timelapse frames
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

  // Get recent pixel events
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

  // Get pixel history for a specific location
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

export const canvasService = new CanvasService();
