const express = require('express');
const db = require('../db');
const { client: redis } = require('../db/redis');
const { isAuthenticated, hasSubscription } = require('../middleware/auth');
const config = require('../config');

// Shared observability and resilience modules
const { logger, auditLog, AuditEvents } = require('../shared/logger');
const {
  manifestGenerationDuration,
  activeStreams,
  segmentRequestsTotal,
  streamingErrors,
  playbackStartLatency
} = require('../shared/metrics');
const { withCircuitBreaker } = require('../shared/circuitBreaker');

const router = express.Router();

// Track active streams per content
const activeStreamTracking = new Map();

/**
 * Helper to track stream lifecycle
 */
function trackStreamStart(contentId, quality, deviceType) {
  const key = `${contentId}:${quality}:${deviceType}`;
  activeStreamTracking.set(key, Date.now());
  activeStreams.inc({ quality, device_type: deviceType });
}

function trackStreamEnd(contentId, quality, deviceType) {
  const key = `${contentId}:${quality}:${deviceType}`;
  if (activeStreamTracking.has(key)) {
    activeStreamTracking.delete(key);
    activeStreams.dec({ quality, device_type: deviceType });
  }
}

// Generate HLS master playlist
router.get('/:contentId/master.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
  const startTime = process.hrtime.bigint();
  const { contentId } = req.params;

  try {
    // Get content info - wrapped in circuit breaker for DB resilience
    const content = await withCircuitBreaker('storage', async () => {
      return db.query(`
        SELECT id, title, duration, status FROM content WHERE id = $1
      `, [contentId]);
    });

    if (content.rows.length === 0) {
      streamingErrors.inc({ error_type: 'content_not_found', content_id: contentId });
      return res.status(404).send('#EXTM3U\n# Content not found');
    }

    if (content.rows[0].status !== 'ready') {
      streamingErrors.inc({ error_type: 'content_not_ready', content_id: contentId });
      return res.status(404).send('#EXTM3U\n# Content not available');
    }

    // Get encoded variants
    const variants = await db.query(`
      SELECT id, resolution, codec, hdr, bitrate
      FROM encoded_variants
      WHERE content_id = $1
      ORDER BY resolution DESC, bitrate DESC
    `, [contentId]);

    // Get audio tracks
    const audioTracks = await db.query(`
      SELECT id, language, name, codec, channels
      FROM audio_tracks
      WHERE content_id = $1
    `, [contentId]);

    // Get subtitles
    const subtitles = await db.query(`
      SELECT id, language, name, type
      FROM subtitles
      WHERE content_id = $1
    `, [contentId]);

    // Generate master playlist
    let playlist = '#EXTM3U\n';
    playlist += '#EXT-X-VERSION:6\n';
    playlist += '#EXT-X-INDEPENDENT-SEGMENTS\n\n';

    // Add audio groups
    for (const audio of audioTracks.rows) {
      const isDefault = audio.language === 'en' ? 'YES' : 'NO';
      playlist += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",`;
      playlist += `LANGUAGE="${audio.language}",NAME="${audio.name}",`;
      playlist += `DEFAULT=${isDefault},AUTOSELECT=${isDefault},`;
      playlist += `URI="/api/stream/${contentId}/audio/${audio.id}.m3u8"\n`;
    }

    // Add subtitle groups
    for (const sub of subtitles.rows) {
      const isDefault = sub.language === 'en' && sub.type === 'caption' ? 'YES' : 'NO';
      playlist += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",`;
      playlist += `LANGUAGE="${sub.language}",NAME="${sub.name}",`;
      playlist += `DEFAULT=${isDefault},AUTOSELECT=${isDefault},`;
      playlist += `URI="/api/stream/${contentId}/subtitles/${sub.id}.m3u8"\n`;
    }

    playlist += '\n';

    // Add video variants
    for (const variant of variants.rows) {
      const bandwidth = variant.bitrate * 1000;
      const width = Math.round(variant.resolution * 16 / 9);
      const resolution = `${width}x${variant.resolution}`;

      let codecs;
      if (variant.codec === 'hevc' && variant.hdr) {
        codecs = 'hvc1.2.4.L150.B0,mp4a.40.2';
      } else if (variant.codec === 'hevc') {
        codecs = 'hvc1.1.6.L150.90,mp4a.40.2';
      } else {
        codecs = 'avc1.640029,mp4a.40.2';
      }

      playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},`;
      playlist += `RESOLUTION=${resolution},CODECS="${codecs}",`;
      playlist += `AUDIO="audio",SUBTITLES="subs"\n`;
      playlist += `/api/stream/${contentId}/variant/${variant.id}.m3u8\n`;
    }

    // Record manifest generation duration
    const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
    manifestGenerationDuration.observe({ manifest_type: 'master' }, duration);

    // Log audit event for content access
    auditLog(AuditEvents.CONTENT_ACCESSED, {
      userId: req.session.userId,
      profileId: req.session.profileId,
      contentId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      details: { type: 'manifest_request' }
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    streamingErrors.inc({ error_type: 'manifest_generation', content_id: contentId });
    if (req.log) {
      req.log.error({ error: error.message, contentId }, 'Generate master playlist error');
    } else {
      logger.error({ error: error.message, contentId }, 'Generate master playlist error');
    }
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Generate variant playlist (video quality level)
router.get('/:contentId/variant/:variantId.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
  const startTime = process.hrtime.bigint();

  try {
    const { contentId, variantId } = req.params;

    // Get content duration
    const content = await db.query(`
      SELECT duration FROM content WHERE id = $1
    `, [contentId]);

    if (content.rows.length === 0) {
      return res.status(404).send('#EXTM3U\n# Content not found');
    }

    const duration = content.rows[0].duration;
    const segmentDuration = 6; // 6 second segments
    const segmentCount = Math.ceil(duration / segmentDuration);

    let playlist = '#EXTM3U\n';
    playlist += '#EXT-X-VERSION:6\n';
    playlist += `#EXT-X-TARGETDURATION:${segmentDuration}\n`;
    playlist += '#EXT-X-MEDIA-SEQUENCE:0\n';
    playlist += '#EXT-X-PLAYLIST-TYPE:VOD\n\n';

    for (let i = 0; i < segmentCount; i++) {
      const segDuration = Math.min(segmentDuration, duration - (i * segmentDuration));
      playlist += `#EXTINF:${segDuration.toFixed(3)},\n`;
      playlist += `/api/stream/${contentId}/segment/${variantId}/${i}.ts\n`;
    }

    playlist += '#EXT-X-ENDLIST\n';

    // Record manifest generation duration
    const genDuration = Number(process.hrtime.bigint() - startTime) / 1e9;
    manifestGenerationDuration.observe({ manifest_type: 'variant' }, genDuration);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    const { contentId } = req.params;
    streamingErrors.inc({ error_type: 'variant_manifest', content_id: contentId });
    if (req.log) {
      req.log.error({ error: error.message }, 'Generate variant playlist error');
    }
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Generate audio playlist
router.get('/:contentId/audio/:audioId.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
  const startTime = process.hrtime.bigint();

  try {
    const { contentId, audioId } = req.params;

    const content = await db.query(`
      SELECT duration FROM content WHERE id = $1
    `, [contentId]);

    if (content.rows.length === 0) {
      return res.status(404).send('#EXTM3U\n# Content not found');
    }

    const duration = content.rows[0].duration;
    const segmentDuration = 6;
    const segmentCount = Math.ceil(duration / segmentDuration);

    let playlist = '#EXTM3U\n';
    playlist += '#EXT-X-VERSION:6\n';
    playlist += `#EXT-X-TARGETDURATION:${segmentDuration}\n`;
    playlist += '#EXT-X-MEDIA-SEQUENCE:0\n';
    playlist += '#EXT-X-PLAYLIST-TYPE:VOD\n\n';

    for (let i = 0; i < segmentCount; i++) {
      const segDuration = Math.min(segmentDuration, duration - (i * segmentDuration));
      playlist += `#EXTINF:${segDuration.toFixed(3)},\n`;
      playlist += `/api/stream/${contentId}/audio-segment/${audioId}/${i}.aac\n`;
    }

    playlist += '#EXT-X-ENDLIST\n';

    // Record manifest generation duration
    const genDuration = Number(process.hrtime.bigint() - startTime) / 1e9;
    manifestGenerationDuration.observe({ manifest_type: 'audio' }, genDuration);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Generate audio playlist error');
    }
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Generate subtitle playlist
router.get('/:contentId/subtitles/:subId.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
  const startTime = process.hrtime.bigint();

  try {
    const { contentId, subId } = req.params;

    let playlist = '#EXTM3U\n';
    playlist += '#EXT-X-VERSION:6\n';
    playlist += '#EXT-X-TARGETDURATION:9999\n';
    playlist += '#EXT-X-MEDIA-SEQUENCE:0\n';
    playlist += '#EXT-X-PLAYLIST-TYPE:VOD\n\n';
    playlist += '#EXTINF:9999,\n';
    playlist += `/api/stream/${contentId}/subtitle-file/${subId}.vtt\n`;
    playlist += '#EXT-X-ENDLIST\n';

    // Record manifest generation duration
    const genDuration = Number(process.hrtime.bigint() - startTime) / 1e9;
    manifestGenerationDuration.observe({ manifest_type: 'subtitle' }, genDuration);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Generate subtitle playlist error');
    }
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Serve video segment (simulated - in production would come from CDN/MinIO)
router.get('/:contentId/segment/:variantId/:segmentNum.ts', isAuthenticated, hasSubscription, async (req, res) => {
  try {
    const { contentId, variantId, segmentNum } = req.params;

    // Track segment request metrics
    segmentRequestsTotal.inc({ content_id: contentId, quality: variantId });

    // In a real implementation, this would fetch from MinIO/CDN with circuit breaker
    const segmentData = await withCircuitBreaker('cdn', async () => {
      // Simulated CDN fetch - in production this would be actual segment data
      await redis.incr(`segment:${contentId}:${variantId}:${segmentNum}`);
      return Buffer.alloc(0); // Would contain actual segment data
    });

    res.setHeader('Content-Type', 'video/mp2t');
    res.status(200).send(segmentData);
  } catch (error) {
    const { contentId } = req.params;
    streamingErrors.inc({ error_type: 'segment_fetch', content_id: contentId });
    if (req.log) {
      req.log.error({ error: error.message }, 'Serve segment error');
    }
    res.status(500).send('Server error');
  }
});

// Serve audio segment
router.get('/:contentId/audio-segment/:audioId/:segmentNum.aac', isAuthenticated, hasSubscription, async (req, res) => {
  try {
    const { contentId, audioId, segmentNum } = req.params;

    // Track segment request with circuit breaker
    await withCircuitBreaker('cdn', async () => {
      await redis.incr(`audio-segment:${contentId}:${audioId}:${segmentNum}`);
      return true;
    });

    res.setHeader('Content-Type', 'audio/aac');
    res.status(200).send(''); // Would send actual audio data
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Serve audio segment error');
    }
    res.status(500).send('Server error');
  }
});

// Serve subtitle file
router.get('/:contentId/subtitle-file/:subId.vtt', isAuthenticated, hasSubscription, async (req, res) => {
  try {
    const { contentId, subId } = req.params;

    // Generate sample VTT content
    const content = await db.query(`
      SELECT duration FROM content WHERE id = $1
    `, [contentId]);

    if (content.rows.length === 0) {
      return res.status(404).send('Content not found');
    }

    let vtt = 'WEBVTT\n\n';
    vtt += '1\n';
    vtt += '00:00:00.000 --> 00:00:05.000\n';
    vtt += 'Sample subtitle text\n\n';
    vtt += '2\n';
    vtt += '00:00:05.000 --> 00:00:10.000\n';
    vtt += 'This is a demo subtitle\n\n';

    res.setHeader('Content-Type', 'text/vtt');
    res.send(vtt);
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Serve subtitle error');
    }
    res.status(500).send('Server error');
  }
});

// Get playback URL (used by client to initiate streaming)
router.get('/:contentId/playback', isAuthenticated, hasSubscription, async (req, res) => {
  const startTime = process.hrtime.bigint();

  try {
    const { contentId } = req.params;
    const deviceType = req.headers['x-device-type'] || 'unknown';

    // Verify content exists and is ready
    const content = await db.query(`
      SELECT id, title, duration, status FROM content WHERE id = $1
    `, [contentId]);

    if (content.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    if (content.rows[0].status !== 'ready') {
      return res.status(404).json({ error: 'Content not available' });
    }

    // Generate playback token (in production, this would be a signed JWT)
    const playbackToken = Buffer.from(JSON.stringify({
      contentId,
      userId: req.session.userId,
      profileId: req.session.profileId,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    })).toString('base64');

    // Track playback start latency
    const latency = Number(process.hrtime.bigint() - startTime) / 1e9;
    playbackStartLatency.observe({
      device_type: deviceType,
      quality: 'auto'
    }, latency);

    // Track active stream
    trackStreamStart(contentId, 'auto', deviceType);

    // Audit log for playback start
    auditLog(AuditEvents.PLAYBACK_STARTED, {
      userId: req.session.userId,
      profileId: req.session.profileId,
      contentId,
      deviceId: req.headers['x-device-id'],
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      details: { deviceType, latency }
    });

    if (req.log) {
      req.log.info({
        contentId,
        deviceType,
        latency
      }, 'Playback initiated');
    }

    res.json({
      manifestUrl: `/api/stream/${contentId}/master.m3u8`,
      playbackToken,
      content: content.rows[0]
    });
  } catch (error) {
    const { contentId } = req.params;
    streamingErrors.inc({ error_type: 'playback_init', content_id: contentId });
    if (req.log) {
      req.log.error({ error: error.message }, 'Get playback URL error');
    }
    res.status(500).json({ error: 'Failed to get playback URL' });
  }
});

// Endpoint to report playback end (for accurate stream tracking)
router.post('/:contentId/playback/end', isAuthenticated, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { quality, deviceType } = req.body;

    trackStreamEnd(contentId, quality || 'auto', deviceType || 'unknown');

    if (req.log) {
      req.log.info({ contentId, quality, deviceType }, 'Playback ended');
    }

    res.json({ success: true });
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Report playback end error');
    }
    res.status(500).json({ error: 'Failed to report playback end' });
  }
});

module.exports = router;
