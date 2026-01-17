import { query } from '../db/index.js';
import { Stream } from '../types/index.js';
import { redis } from '../utils/redis.js';

export class StreamService {
  async getStream(streamId: string): Promise<Stream | null> {
    const rows = await query<Stream>(
      'SELECT * FROM streams WHERE id = $1',
      [streamId]
    );
    return rows[0] || null;
  }

  async getLiveStreams(): Promise<Stream[]> {
    return query<Stream>(
      'SELECT * FROM streams WHERE status = $1 ORDER BY started_at DESC',
      ['live']
    );
  }

  async getAllStreams(): Promise<Stream[]> {
    return query<Stream>(
      'SELECT * FROM streams ORDER BY started_at DESC'
    );
  }

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

  async endStream(streamId: string): Promise<Stream | null> {
    const rows = await query<Stream>(
      `UPDATE streams SET status = 'ended', ended_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [streamId]
    );
    return rows[0] || null;
  }

  async updateViewerCount(streamId: string, count: number): Promise<void> {
    await query(
      'UPDATE streams SET viewer_count = $1, updated_at = NOW() WHERE id = $2',
      [count, streamId]
    );
    // Also cache in Redis for quick access
    await redis.hset(`stream:${streamId}`, 'viewer_count', count.toString());
  }

  async incrementCommentCount(streamId: string): Promise<void> {
    await query(
      'UPDATE streams SET comment_count = comment_count + 1, updated_at = NOW() WHERE id = $1',
      [streamId]
    );
    await redis.hincrby(`stream:${streamId}`, 'comment_count', 1);
  }

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

export const streamService = new StreamService();
