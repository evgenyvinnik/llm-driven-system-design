const { query } = require('./database');

// This service simulates live streams for demo purposes
// In production, this would be handled by actual RTMP ingest + transcoding

const liveStreams = new Map();

function setupStreamSimulator() {
  // Update viewer counts periodically
  setInterval(async () => {
    try {
      const result = await query(`
        SELECT id, current_viewers FROM channels WHERE is_live = TRUE
      `);

      for (const channel of result.rows) {
        // Simulate fluctuating viewer counts
        const variance = Math.floor(Math.random() * 1000) - 500;
        const newCount = Math.max(100, channel.current_viewers + variance);

        await query(`
          UPDATE channels SET current_viewers = $1, updated_at = NOW()
          WHERE id = $2
        `, [newCount, channel.id]);
      }
    } catch (error) {
      console.error('Error updating viewer counts:', error);
    }
  }, 30000); // Every 30 seconds

  console.log('Stream simulator initialized');
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

  return streamResult.rows[0];
}

async function endStream(channelId) {
  const streamInfo = liveStreams.get(channelId);

  await query(`
    UPDATE channels
    SET is_live = FALSE, current_viewers = 0, updated_at = NOW()
    WHERE id = $1
  `, [channelId]);

  if (streamInfo) {
    await query(`
      UPDATE streams
      SET ended_at = NOW()
      WHERE id = $1
    `, [streamInfo.streamId]);

    liveStreams.delete(channelId);
  }
}

module.exports = {
  setupStreamSimulator,
  generateHLSManifest,
  generateMasterPlaylist,
  startStream,
  endStream
};
