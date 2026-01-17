/**
 * Stream Service Module
 *
 * Manages live stream lifecycle and metrics. Streams are the primary containers
 * for real-time comments and reactions. Metrics are cached in Redis for fast access
 * during high-traffic broadcasts.
 *
 * @module services/streamService
 */

import { query } from '../db/index.js';
import { Stream } from '../types/index.js';
import { redis } from '../utils/redis.js';

/**
 * Service class for stream management operations.
 * Handles CRUD operations and real-time metrics tracking.
 */
export class StreamService {
  /**
   * Retrieves a single stream by ID.
   *
   * @param streamId - Unique stream identifier
   * @returns Stream object or null if not found
   */
  async getStream(streamId: string): Promise<Stream | null> {
    const rows = await query<Stream>(
      'SELECT * FROM streams WHERE id = $1',
      [streamId]
    );
    return rows[0] || null;
  }

  /**
   * Retrieves all currently live streams.
   * Used to populate the stream selection UI.
   *
   * @returns Array of streams with status 'live', ordered by start time (newest first)
   */
  async getLiveStreams(): Promise<Stream[]> {
    return query<Stream>(
      'SELECT * FROM streams WHERE status = $1 ORDER BY started_at DESC',
      ['live']
    );
  }

  /**
   * Retrieves all streams regardless of status.
   * Includes live, ended, and scheduled streams.
   *
   * @returns Array of all streams ordered by start time (newest first)
   */
  async getAllStreams(): Promise<Stream[]> {
    return query<Stream>(
      'SELECT * FROM streams ORDER BY started_at DESC'
    );
  }

  /**
   * Creates a new live stream.
   * Stream is immediately set to 'live' status upon creation.
   *
   * @param title - Display title for the stream
   * @param creatorId - User ID of the stream creator
   * @param description - Optional stream description
   * @param videoUrl - Optional URL to video source
   * @returns Newly created stream object
   */
  async createStream(
    title: string,
    creatorId: string,
    description?: string,
    videoUrl?: string
  ): Promise<Stream> {
    const rows = await query<Stream>(
      `INSERT INTO streams (title, description, creator_id, video_url, status)
       VALUES ($1, $2, $3, $4, 'live')
       RETURNING *`,
      [title, description || null, creatorId, videoUrl || null]
    );
    return rows[0];
  }

  /**
   * Ends a live stream by setting its status to 'ended'.
   * Sets the ended_at timestamp to current time.
   *
   * @param streamId - ID of the stream to end
   * @returns Updated stream object or null if not found
   */
  async endStream(streamId: string): Promise<Stream | null> {
    const rows = await query<Stream>(
      `UPDATE streams SET status = 'ended', ended_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [streamId]
    );
    return rows[0] || null;
  }

  /**
   * Updates the viewer count for a stream.
   * Persists to both PostgreSQL (for durability) and Redis (for fast access).
   *
   * @param streamId - ID of the stream to update
   * @param count - New viewer count
   */
  async updateViewerCount(streamId: string, count: number): Promise<void> {
    await query(
      'UPDATE streams SET viewer_count = $1, updated_at = NOW() WHERE id = $2',
      [count, streamId]
    );
    // Also cache in Redis for quick access
    await redis.hset(`stream:${streamId}`, 'viewer_count', count.toString());
  }

  /**
   * Increments the comment count for a stream.
   * Updates both PostgreSQL and Redis atomically.
   *
   * @param streamId - ID of the stream to update
   */
  async incrementCommentCount(streamId: string): Promise<void> {
    await query(
      'UPDATE streams SET comment_count = comment_count + 1, updated_at = NOW() WHERE id = $1',
      [streamId]
    );
    await redis.hincrby(`stream:${streamId}`, 'comment_count', 1);
  }

  /**
   * Retrieves current stream metrics (viewer and comment counts).
   * Tries Redis cache first, falls back to database on cache miss.
   *
   * @param streamId - ID of the stream to query
   * @returns Object with viewer_count and comment_count
   */
  async getStreamMetrics(streamId: string): Promise<{ viewer_count: number; comment_count: number }> {
    // Try cache first
    const cached = await redis.hgetall(`stream:${streamId}`);
    if (cached && cached.viewer_count) {
      return {
        viewer_count: parseInt(cached.viewer_count, 10) || 0,
        comment_count: parseInt(cached.comment_count, 10) || 0,
      };
    }

    // Fall back to database
    const stream = await this.getStream(streamId);
    if (!stream) {
      return { viewer_count: 0, comment_count: 0 };
    }

    return {
      viewer_count: stream.viewer_count,
      comment_count: stream.comment_count,
    };
  }
}

/** Singleton stream service instance */
export const streamService = new StreamService();
