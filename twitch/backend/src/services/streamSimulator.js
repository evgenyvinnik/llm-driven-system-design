const { query } = require('./database');
const { logger, logStreamEvent } = require('../utils/logger');
const { incStreamStart, incStreamEnd, setTotalViewers, setActiveStreams } = require('../utils/metrics');
const { acquireStreamLock, releaseStreamLock } = require('../utils/idempotency');
const { getRedisClient } = require('./redis');

// This service simulates live streams for demo purposes
// In production, this would be handled by actual RTMP ingest + transcoding

const liveStreams = new Map();

function setupStreamSimulator() {
  // Update viewer counts and metrics periodically
  setInterval(async () => {
    try {
      const result = await query(`
        SELECT id, current_viewers FROM channels WHERE is_live = TRUE
      `);

      let totalViewers = 0;
      for (const channel of result.rows) {
        // Simulate fluctuating viewer counts
        const variance = Math.floor(Math.random() * 1000) - 500;
        const newCount = Math.max(100, channel.current_viewers + variance);
        totalViewers += newCount;

        await query(`
          UPDATE channels SET current_viewers = $1, updated_at = NOW()
          WHERE id = $2
        `, [newCount, channel.id]);
      }

      // Update Prometheus metrics
      setActiveStreams(result.rows.length);
      setTotalViewers(totalViewers);

    } catch (error) {
      logger.error({ error: error.message }, 'Error updating viewer counts');
    }
  }, 30000); // Every 30 seconds

  logger.info('Stream simulator initialized');
}

// Simulated HLS manifest for demo
function generateHLSManifest(channelId) {
  const baseUrl = `http://localhost:3001/api/streams/${channelId}/segments`;
  const now = Date.now();

  return `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:${Math.floor(now / 4000)}
#EXTINF:4.000,
${baseUrl}/segment_${Math.floor(now / 4000) - 2}.ts
#EXTINF:4.000,
${baseUrl}/segment_${Math.floor(now / 4000) - 1}.ts
#EXTINF:4.000,
${baseUrl}/segment_${Math.floor(now / 4000)}.ts
`;
}

function generateMasterPlaylist(channelId) {
  const baseUrl = `http://localhost:3001/api/streams/${channelId}`;

  return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,NAME="1080p"
${baseUrl}/playlist_1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,NAME="720p"
${baseUrl}/playlist_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480,NAME="480p"
${baseUrl}/playlist_480p.m3u8
`;
}

async function startStream(channelId, title, categoryId) {
  const redis = getRedisClient();

  // Acquire lock to prevent duplicate go-live events from RTMP reconnects
  const { acquired } = await acquireStreamLock(redis, channelId);
  if (!acquired) {
    logger.warn({ channel_id: channelId }, 'Stream start blocked - lock not acquired');
    // Check if already live (might be a reconnect)
    const checkResult = await query('SELECT is_live FROM channels WHERE id = $1', [channelId]);
    if (checkResult.rows[0]?.is_live) {
      return { reconnect: true, message: 'Stream already live' };
    }
    throw new Error('Failed to acquire stream lock');
  }

  try {
    await query(`
      UPDATE channels
      SET is_live = TRUE, title = $2, category_id = $3, updated_at = NOW()
      WHERE id = $1
    `, [channelId, title, categoryId]);

    const streamResult = await query(`
      INSERT INTO streams (channel_id, title, category_id)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [channelId, title, categoryId]);

    liveStreams.set(channelId, {
      streamId: streamResult.rows[0].id,
      startedAt: Date.now()
    });

    // Update metrics
    incStreamStart();

    // Log stream event
    logStreamEvent('start', channelId, {
      stream_id: streamResult.rows[0].id,
      title,
      category_id: categoryId
    });

    return streamResult.rows[0];
  } finally {
    await releaseStreamLock(redis, channelId);
  }
}

async function endStream(channelId) {
  const streamInfo = liveStreams.get(channelId);

  await query(`
    UPDATE channels
    SET is_live = FALSE, current_viewers = 0, updated_at = NOW()
    WHERE id = $1
  `, [channelId]);

  if (streamInfo) {
    const duration = Math.round((Date.now() - streamInfo.startedAt) / 1000 / 60);

    await query(`
      UPDATE streams
      SET ended_at = NOW()
      WHERE id = $1
    `, [streamInfo.streamId]);

    liveStreams.delete(channelId);

    // Update metrics
    incStreamEnd();

    // Log stream event
    logStreamEvent('end', channelId, {
      stream_id: streamInfo.streamId,
      duration_minutes: duration
    });

    return { streamId: streamInfo.streamId, durationMinutes: duration };
  }

  return null;
}

module.exports = {
  setupStreamSimulator,
  generateHLSManifest,
  generateMasterPlaylist,
  startStream,
  endStream
};
