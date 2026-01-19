/**
 * Analytics Worker
 *
 * Consumes playback events from Kafka and updates:
 * - Track play counts
 * - User listening history metrics
 * - Listening time calculations
 * - User taste profile (top genres, artists)
 */

import { consumePlaybackEvents, disconnectConsumer } from '../shared/kafka.js';
import { pool } from '../db.js';
import { redisClient, initializeDatabase } from '../db.js';
import { logger } from '../shared/logger.js';
import type { KafkaPlaybackMessage, PlaybackEventType } from '../types.js';

// Cache TTLs
const USER_STATS_TTL = 3600; // 1 hour
const _ARTIST_STATS_TTL = 1800; // 30 minutes

interface PlaybackEvent {
  userId: string;
  trackId: string;
  eventType: PlaybackEventType;
  position: number;
  timestamp: number;
  deviceType: string;
}

interface PlaySession {
  startTime?: string;
  deviceType?: string;
  pauseTime?: string;
  lastPosition?: string;
}

interface TrackWithAudioFeatures {
  id: string;
  audio_features: {
    genres?: string[];
  } | null;
  artist_id: string;
  artist_name: string;
}

/**
 * Process a playback event from Kafka
 */
async function processPlaybackEvent(event: KafkaPlaybackMessage): Promise<void> {
  const { userId, trackId, eventType, position, timestamp, deviceType } = event as PlaybackEvent;

  logger.debug({ userId, trackId, eventType, position }, 'Processing playback event');

  try {
    switch (eventType) {
      case 'play_started':
        await handlePlayStarted(userId, trackId, timestamp, deviceType);
        break;

      case 'play_paused':
        await handlePlayPaused(userId, trackId, position, timestamp);
        break;

      case 'play_resumed':
        await handlePlayResumed(userId, trackId, timestamp);
        break;

      case 'play_completed':
        await handlePlayCompleted(userId, trackId, position, timestamp);
        break;

      case 'stream_counted':
        await handleStreamCounted(userId, trackId);
        break;

      case 'skipped':
        await handleSkipped(userId, trackId, position, timestamp);
        break;

      case 'seeked':
        await handleSeeked(userId, trackId, position);
        break;

      default:
        logger.warn({ eventType }, 'Unknown event type');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage, event }, 'Error processing playback event');
  }
}

/**
 * Handle play_started event
 */
async function handlePlayStarted(userId: string, trackId: string, timestamp: number, deviceType: string): Promise<void> {
  // Store session start time in Redis
  const sessionKey = `play_session:${userId}:${trackId}`;
  await redisClient.hSet(sessionKey, {
    startTime: timestamp.toString(),
    deviceType: deviceType || 'web',
  });
  await redisClient.expire(sessionKey, 86400); // 24 hour expiry

  // Increment daily play count for the user
  await incrementDailyListeningStats(userId, 'plays');

  logger.info({ userId, trackId }, 'Play session started');
}

/**
 * Handle play_paused event
 */
async function handlePlayPaused(userId: string, trackId: string, position: number, timestamp: number): Promise<void> {
  const sessionKey = `play_session:${userId}:${trackId}`;
  const session = await redisClient.hGetAll(sessionKey) as PlaySession;

  if (session.startTime) {
    const listenDuration = timestamp - parseInt(session.startTime);
    await updateListeningTime(userId, trackId, listenDuration);

    // Update session with pause time
    await redisClient.hSet(sessionKey, {
      pauseTime: timestamp.toString(),
      lastPosition: position.toString(),
    });
  }

  logger.info({ userId, trackId, position }, 'Play session paused');
}

/**
 * Handle play_resumed event
 */
async function handlePlayResumed(userId: string, trackId: string, timestamp: number): Promise<void> {
  const sessionKey = `play_session:${userId}:${trackId}`;

  // Reset start time for duration calculation
  await redisClient.hSet(sessionKey, {
    startTime: timestamp.toString(),
  });

  logger.info({ userId, trackId }, 'Play session resumed');
}

/**
 * Handle play_completed event
 */
async function handlePlayCompleted(userId: string, trackId: string, position: number, timestamp: number): Promise<void> {
  const sessionKey = `play_session:${userId}:${trackId}`;
  const session = await redisClient.hGetAll(sessionKey) as PlaySession;

  if (session.startTime) {
    const listenDuration = timestamp - parseInt(session.startTime);
    await updateListeningTime(userId, trackId, listenDuration);
  }

  // Update taste profile with completed track
  await updateUserTasteProfile(userId, trackId, true);

  // Increment completion count
  await incrementDailyListeningStats(userId, 'completions');

  // Clean up session
  await redisClient.del(sessionKey);

  logger.info({ userId, trackId, position }, 'Play session completed');
}

/**
 * Handle stream_counted event (30 seconds threshold)
 */
async function handleStreamCounted(userId: string, trackId: string): Promise<void> {
  // Update taste profile with partial listen
  await updateUserTasteProfile(userId, trackId, false);

  // Increment stream count for the artist
  await updateArtistStreamCount(trackId);

  logger.info({ userId, trackId }, 'Stream counted');
}

/**
 * Handle skipped event
 */
async function handleSkipped(userId: string, trackId: string, position: number, timestamp: number): Promise<void> {
  const sessionKey = `play_session:${userId}:${trackId}`;
  const session = await redisClient.hGetAll(sessionKey) as PlaySession;

  if (session.startTime) {
    const listenDuration = timestamp - parseInt(session.startTime);
    await updateListeningTime(userId, trackId, listenDuration);
  }

  // Increment skip count
  await incrementDailyListeningStats(userId, 'skips');

  // Record skip position for analytics
  await recordSkipPosition(trackId, position);

  // Clean up session
  await redisClient.del(sessionKey);

  logger.info({ userId, trackId, position }, 'Track skipped');
}

/**
 * Handle seeked event
 */
async function handleSeeked(userId: string, trackId: string, position: number): Promise<void> {
  // Just log for now, could be used for content engagement analysis
  logger.debug({ userId, trackId, position }, 'Track seeked');
}

/**
 * Update total listening time for user and track
 */
async function updateListeningTime(userId: string, trackId: string, durationMs: number): Promise<void> {
  if (durationMs <= 0) return;

  // Update user's total listening time in Redis (daily aggregate)
  const dateKey = new Date().toISOString().split('T')[0];
  const userTimeKey = `listening_time:${userId}:${dateKey}`;

  await redisClient.incrBy(userTimeKey, durationMs);
  await redisClient.expire(userTimeKey, 86400 * 30); // Keep for 30 days

  // Update track's total listen time (aggregate)
  const trackTimeKey = `track_listen_time:${trackId}`;
  await redisClient.incrBy(trackTimeKey, durationMs);
}

/**
 * Update user taste profile based on track listened
 */
async function updateUserTasteProfile(userId: string, trackId: string, completed: boolean): Promise<void> {
  try {
    // Get track details with artist and genres
    const result = await pool.query<TrackWithAudioFeatures>(
      `SELECT t.id, t.audio_features, a.artist_id, ar.name as artist_name
       FROM tracks t
       JOIN albums a ON t.album_id = a.id
       JOIN artists ar ON a.artist_id = ar.id
       WHERE t.id = $1`,
      [trackId]
    );

    if (result.rows.length === 0) return;

    const track = result.rows[0];
    const weight = completed ? 1.0 : 0.5; // Full weight for completed tracks

    // Update artist affinity in Redis
    const artistAffinityKey = `user_taste:${userId}:artists`;
    await redisClient.zIncrBy(artistAffinityKey, weight, track.artist_id);
    await redisClient.expire(artistAffinityKey, USER_STATS_TTL);

    // Extract genres from audio_features if available
    if (track.audio_features && track.audio_features.genres) {
      const genreAffinityKey = `user_taste:${userId}:genres`;
      for (const genre of track.audio_features.genres) {
        await redisClient.zIncrBy(genreAffinityKey, weight, genre);
      }
      await redisClient.expire(genreAffinityKey, USER_STATS_TTL);
    }

    logger.debug({ userId, trackId, artistId: track.artist_id }, 'Updated user taste profile');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage, userId, trackId }, 'Failed to update taste profile');
  }
}

/**
 * Update artist monthly listeners and stream count
 */
async function updateArtistStreamCount(trackId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE artists
       SET monthly_listeners = monthly_listeners + 1
       WHERE id = (
         SELECT a.artist_id FROM tracks t
         JOIN albums a ON t.album_id = a.id
         WHERE t.id = $1
       )`,
      [trackId]
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage, trackId }, 'Failed to update artist stream count');
  }
}

/**
 * Increment daily listening statistics
 */
async function incrementDailyListeningStats(userId: string, statType: string): Promise<void> {
  const dateKey = new Date().toISOString().split('T')[0];
  const statsKey = `daily_stats:${userId}:${dateKey}`;

  await redisClient.hIncrBy(statsKey, statType, 1);
  await redisClient.expire(statsKey, 86400 * 30); // Keep for 30 days
}

/**
 * Record skip position for track analytics
 */
async function recordSkipPosition(trackId: string, position: number): Promise<void> {
  // Store in a Redis sorted set for percentile analysis
  const skipKey = `track_skips:${trackId}`;
  await redisClient.zAdd(skipKey, { score: position, value: Date.now().toString() });

  // Keep only last 1000 skip events
  await redisClient.zRemRangeByRank(skipKey, 0, -1001);
  await redisClient.expire(skipKey, 86400 * 7); // Keep for 7 days
}

/**
 * Graceful shutdown handler
 */
async function shutdown(): Promise<void> {
  logger.info('Shutting down analytics worker...');

  try {
    await disconnectConsumer();
    await redisClient.quit();
    await pool.end();
    logger.info('Analytics worker shutdown complete');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage }, 'Error during shutdown');
  }

  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('Starting analytics worker...');

  try {
    // Initialize database connections
    await initializeDatabase();
    logger.info('Database connections initialized');

    // Start consuming playback events
    await consumePlaybackEvents(processPlaybackEvent);
    logger.info('Analytics worker is running');

    // Handle graceful shutdown
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: errorMessage }, 'Failed to start analytics worker');
    process.exit(1);
  }
}

main();
