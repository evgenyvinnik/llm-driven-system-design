import { pool } from '../db.js';
import { redisClient } from '../db.js';
import { getPresignedUrl, AUDIO_BUCKET } from '../storage.js';
import { publishPlaybackEvent } from '../shared/kafka.js';
import { logger } from '../shared/logger.js';

// Get stream URL for a track
export async function getStreamUrl(trackId, _userId) {
  // Get track info
  const trackResult = await pool.query(
    'SELECT audio_url, duration_ms FROM tracks WHERE id = $1',
    [trackId]
  );

  if (trackResult.rows.length === 0) {
    throw new Error('Track not found');
  }

  const track = trackResult.rows[0];

  // If audio_url is already a full URL (for demo purposes), return it
  if (track.audio_url && track.audio_url.startsWith('http')) {
    return {
      url: track.audio_url,
      expiresAt: Date.now() + 3600000,
    };
  }

  // For MinIO storage, generate presigned URL
  if (track.audio_url) {
    try {
      const presignedUrl = await getPresignedUrl(AUDIO_BUCKET, track.audio_url, 3600);
      return {
        url: presignedUrl,
        expiresAt: Date.now() + 3600000,
      };
    } catch (error) {
      console.error('Error generating presigned URL:', error);
      throw new Error('Unable to generate stream URL');
    }
  }

  throw new Error('No audio file available');
}

// Record playback event
export async function recordPlaybackEvent(userId, trackId, eventType, positionMs = 0, deviceType = 'web') {
  await pool.query(
    `INSERT INTO playback_events (user_id, track_id, event_type, position_ms, device_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, trackId, eventType, positionMs, deviceType]
  );

  // If this is a stream count event (30 seconds or 50% played)
  if (eventType === 'stream_counted') {
    await pool.query(
      'UPDATE tracks SET stream_count = stream_count + 1 WHERE id = $1',
      [trackId]
    );
  }

  // Record to listening history for recommendations
  if (eventType === 'play_started') {
    await pool.query(
      `INSERT INTO listening_history (user_id, track_id, duration_played_ms, completed)
       VALUES ($1, $2, 0, false)`,
      [userId, trackId]
    );
  } else if (eventType === 'play_completed') {
    // Update the most recent listening history entry
    await pool.query(
      `UPDATE listening_history
       SET duration_played_ms = $3, completed = true
       WHERE id = (
         SELECT id FROM listening_history
         WHERE user_id = $1 AND track_id = $2
         ORDER BY played_at DESC
         LIMIT 1
       )`,
      [userId, trackId, positionMs]
    );
  }

  // Publish to Kafka for analytics processing
  try {
    await publishPlaybackEvent(userId, trackId, eventType, positionMs, { deviceType });
  } catch (error) {
    // Log error but don't fail the request - Kafka is non-blocking
    logger.error({ error: error.message, userId, trackId, eventType }, 'Failed to publish to Kafka');
  }

  return { recorded: true };
}

// Get recently played tracks
export async function getRecentlyPlayed(userId, { limit = 50 }) {
  const result = await pool.query(
    `SELECT DISTINCT ON (t.id)
            t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id,
            lh.played_at
     FROM listening_history lh
     JOIN tracks t ON lh.track_id = t.id
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE lh.user_id = $1
     ORDER BY t.id, lh.played_at DESC
     LIMIT $2`,
    [userId, limit * 2]
  );

  // Re-sort by played_at and limit
  const sorted = result.rows.sort((a, b) =>
    new Date(b.played_at) - new Date(a.played_at)
  ).slice(0, limit);

  return sorted;
}

// Store and retrieve playback state (for cross-device sync)
export async function savePlaybackState(userId, state) {
  const key = `playback_state:${userId}`;
  await redisClient.setEx(key, 86400, JSON.stringify(state)); // 24 hour expiry
  return { saved: true };
}

export async function getPlaybackState(userId) {
  const key = `playback_state:${userId}`;
  const state = await redisClient.get(key);
  return state ? JSON.parse(state) : null;
}

// Get play count statistics
export async function getTrackStats(trackId) {
  const result = await pool.query(
    `SELECT
       stream_count,
       (SELECT COUNT(*) FROM user_library WHERE item_type = 'track' AND item_id = $1) as like_count
     FROM tracks
     WHERE id = $1`,
    [trackId]
  );

  return result.rows[0] || { stream_count: 0, like_count: 0 };
}

export default {
  getStreamUrl,
  recordPlaybackEvent,
  getRecentlyPlayed,
  savePlaybackState,
  getPlaybackState,
  getTrackStats,
};
