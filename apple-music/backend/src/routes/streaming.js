import { Router } from 'express';
import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { getSignedDownloadUrl, getPublicUrl, BUCKETS } from '../services/minio.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { streamStartLatency, activeStreams, streamsTotal, cacheHits } from '../shared/metrics.js';
import { logger, logStreamEvent } from '../shared/logger.js';

const router = Router();

/**
 * Streaming routes with comprehensive metrics.
 *
 * Metrics tracked:
 * - Stream start latency (time to first byte)
 * - Active streams count (for capacity planning)
 * - Total streams by quality and subscription tier
 * - Cache hits for stream URL generation
 */

// Quality options and their settings
const QUALITY_OPTIONS = {
  '256_aac': { format: 'aac', bitrate: 256, sampleRate: 44100, bitDepth: 16 },
  '256_aac_plus': { format: 'aac', bitrate: 256, sampleRate: 48000, bitDepth: 16 },
  'lossless': { format: 'alac', bitrate: 1411, sampleRate: 44100, bitDepth: 16 },
  'hi_res_lossless': { format: 'alac', bitrate: 9216, sampleRate: 192000, bitDepth: 24 }
};

// Subscription tier max quality
const TIER_MAX_QUALITY = {
  'free': '256_aac',
  'student': 'lossless',
  'individual': 'hi_res_lossless',
  'family': 'hi_res_lossless'
};

// Select quality based on preferences and network
function selectQuality(preferred, network, maxTierQuality) {
  const qualities = ['256_aac', '256_aac_plus', 'lossless', 'hi_res_lossless'];

  const preferredIndex = qualities.indexOf(preferred);
  const maxIndex = qualities.indexOf(maxTierQuality);

  // Network constraints
  const networkMax = {
    'wifi': 'hi_res_lossless',
    'cellular_5g': 'lossless',
    'cellular_lte': '256_aac_plus',
    'cellular_3g': '256_aac'
  }[network] || 'lossless';

  const networkIndex = qualities.indexOf(networkMax);

  const selectedIndex = Math.min(
    preferredIndex >= 0 ? preferredIndex : 0,
    maxIndex,
    networkIndex
  );

  return qualities[selectedIndex];
}

// Get stream URL for a track
router.get('/:trackId', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { trackId } = req.params;
    const { quality: preferredQuality, network = 'wifi' } = req.query;
    const userId = req.user.id;
    const subscriptionTier = req.user.subscriptionTier || 'free';

    // Get track info
    const trackResult = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE t.id = $1`,
      [trackId]
    );

    if (trackResult.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const track = trackResult.rows[0];

    // Determine quality
    const maxTierQuality = TIER_MAX_QUALITY[subscriptionTier] || '256_aac';
    const userPreferred = preferredQuality || req.user.preferredQuality || '256_aac';
    const quality = selectQuality(userPreferred, network, maxTierQuality);

    // Check for existing audio file
    const audioFileResult = await pool.query(
      'SELECT * FROM audio_files WHERE track_id = $1 AND quality = $2',
      [trackId, quality]
    );

    let streamUrl;
    let audioFile;

    if (audioFileResult.rows.length > 0) {
      audioFile = audioFileResult.rows[0];
      // Generate signed URL
      streamUrl = await getSignedDownloadUrl(BUCKETS.AUDIO, audioFile.minio_key, 3600);
      cacheHits.inc({ cache: 'audio_file', result: 'hit' });
    } else {
      // For demo purposes, return a placeholder URL
      // In production, this would point to real audio files
      const qualitySettings = QUALITY_OPTIONS[quality];
      streamUrl = `http://localhost:9000/${BUCKETS.AUDIO}/${trackId}_${quality}.${qualitySettings.format}`;

      audioFile = {
        quality,
        format: qualitySettings.format,
        bitrate: qualitySettings.bitrate,
        sample_rate: qualitySettings.sampleRate,
        bit_depth: qualitySettings.bitDepth
      };
      cacheHits.inc({ cache: 'audio_file', result: 'miss' });
    }

    // Cache the stream info in Redis for quick access
    await redis.setex(
      `stream:${userId}:${trackId}`,
      3600,
      JSON.stringify({
        trackId,
        quality,
        startedAt: Date.now()
      })
    );

    // Increment active streams
    activeStreams.inc({ quality });

    // Track stream metrics
    const latencySeconds = (Date.now() - startTime) / 1000;
    streamStartLatency.observe({ quality, subscription_tier: subscriptionTier }, latencySeconds);
    streamsTotal.inc({ quality, subscription_tier: subscriptionTier });

    // Log stream event
    logStreamEvent('stream_started', userId, trackId, {
      quality,
      subscriptionTier,
      network,
      latencyMs: Date.now() - startTime
    });

    res.json({
      track,
      stream: {
        url: streamUrl,
        quality,
        format: audioFile.format,
        bitrate: audioFile.bitrate,
        sampleRate: audioFile.sample_rate,
        bitDepth: audioFile.bit_depth,
        expiresAt: Date.now() + 3600000 // 1 hour
      }
    });
  } catch (error) {
    logger.error({ err: error, trackId: req.params.trackId }, 'Get stream error');
    res.status(500).json({ error: 'Failed to get stream' });
  }
});

// Prefetch next track (for gapless playback)
router.post('/prefetch', authenticate, async (req, res) => {
  const startTime = Date.now();

  try {
    const { trackId, quality: preferredQuality, network = 'wifi' } = req.body;
    const userId = req.user.id;
    const subscriptionTier = req.user.subscriptionTier || 'free';

    // Get track info
    const trackResult = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE t.id = $1`,
      [trackId]
    );

    if (trackResult.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const track = trackResult.rows[0];

    // Determine quality
    const maxTierQuality = TIER_MAX_QUALITY[subscriptionTier] || '256_aac';
    const userPreferred = preferredQuality || req.user.preferredQuality || '256_aac';
    const quality = selectQuality(userPreferred, network, maxTierQuality);

    const qualitySettings = QUALITY_OPTIONS[quality];
    const streamUrl = `http://localhost:9000/${BUCKETS.AUDIO}/${trackId}_${quality}.${qualitySettings.format}`;

    // Cache prefetch info
    await redis.setex(
      `prefetch:${userId}:${trackId}`,
      300, // 5 minutes
      JSON.stringify({
        trackId,
        quality,
        prefetchedAt: Date.now()
      })
    );

    // Log prefetch event
    logStreamEvent('stream_prefetch', userId, trackId, {
      quality,
      latencyMs: Date.now() - startTime
    });

    res.json({
      track,
      stream: {
        url: streamUrl,
        quality,
        format: qualitySettings.format,
        bitrate: qualitySettings.bitrate,
        expiresAt: Date.now() + 3600000
      },
      prefetched: true
    });
  } catch (error) {
    logger.error({ err: error, trackId: req.body.trackId }, 'Prefetch error');
    res.status(500).json({ error: 'Failed to prefetch' });
  }
});

// Get available qualities for a track
router.get('/:trackId/qualities', optionalAuth, async (req, res) => {
  try {
    const { trackId } = req.params;

    // Get existing audio files
    const result = await pool.query(
      'SELECT quality, format, bitrate, sample_rate, bit_depth, file_size FROM audio_files WHERE track_id = $1',
      [trackId]
    );

    // If no files exist, return all possible qualities
    if (result.rows.length === 0) {
      const qualities = Object.entries(QUALITY_OPTIONS).map(([key, value]) => ({
        quality: key,
        ...value,
        available: true // In demo, all are "available"
      }));

      return res.json({ qualities });
    }

    res.json({
      qualities: result.rows.map(row => ({
        quality: row.quality,
        format: row.format,
        bitrate: row.bitrate,
        sampleRate: row.sample_rate,
        bitDepth: row.bit_depth,
        fileSize: row.file_size,
        available: true
      }))
    });
  } catch (error) {
    logger.error({ err: error, trackId: req.params.trackId }, 'Get qualities error');
    res.status(500).json({ error: 'Failed to get qualities' });
  }
});

// Report playback progress
router.post('/progress', authenticate, async (req, res) => {
  try {
    const { trackId, position, duration, completed } = req.body;
    const userId = req.user.id;

    // Update playback position in Redis
    await redis.setex(
      `playback:${userId}`,
      3600,
      JSON.stringify({
        trackId,
        position,
        duration,
        updatedAt: Date.now()
      })
    );

    // If completed (>30s played), record in history
    if (completed) {
      await pool.query(
        `INSERT INTO listening_history (user_id, track_id, duration_played_ms, completed)
         VALUES ($1, $2, $3, true)`,
        [userId, trackId, position]
      );

      // Update play count
      await pool.query(
        'UPDATE tracks SET play_count = play_count + 1 WHERE id = $1',
        [trackId]
      );

      // Decrement active streams when playback completes
      // Get the quality from Redis cache to decrement correctly
      const streamInfo = await redis.get(`stream:${userId}:${trackId}`);
      if (streamInfo) {
        const { quality } = JSON.parse(streamInfo);
        activeStreams.dec({ quality });
        await redis.del(`stream:${userId}:${trackId}`);
      }

      logStreamEvent('stream_completed', userId, trackId, {
        durationPlayedMs: position
      });
    }

    res.json({ message: 'Progress updated' });
  } catch (error) {
    logger.error({ err: error, trackId: req.body.trackId }, 'Update progress error');
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

// Get current playback state
router.get('/playback/current', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    const playbackData = await redis.get(`playback:${userId}`);

    if (!playbackData) {
      return res.json({ playing: null });
    }

    const playback = JSON.parse(playbackData);

    // Get track info
    const trackResult = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE t.id = $1`,
      [playback.trackId]
    );

    if (trackResult.rows.length === 0) {
      return res.json({ playing: null });
    }

    res.json({
      playing: {
        track: trackResult.rows[0],
        position: playback.position,
        duration: playback.duration,
        updatedAt: playback.updatedAt
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Get playback error');
    res.status(500).json({ error: 'Failed to get playback state' });
  }
});

// Report stream end (explicit stop/skip)
router.post('/end', authenticate, async (req, res) => {
  try {
    const { trackId, reason } = req.body;
    const userId = req.user.id;

    // Get stream info and decrement active streams
    const streamInfo = await redis.get(`stream:${userId}:${trackId}`);
    if (streamInfo) {
      const { quality } = JSON.parse(streamInfo);
      activeStreams.dec({ quality });
      await redis.del(`stream:${userId}:${trackId}`);
    }

    logStreamEvent('stream_ended', userId, trackId, { reason });

    res.json({ message: 'Stream ended' });
  } catch (error) {
    logger.error({ err: error, trackId: req.body.trackId }, 'End stream error');
    res.status(500).json({ error: 'Failed to end stream' });
  }
});

export default router;
