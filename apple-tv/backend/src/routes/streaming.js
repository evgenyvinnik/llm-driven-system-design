const express = require('express');
const db = require('../db');
const { client: redis } = require('../db/redis');
const { isAuthenticated, hasSubscription } = require('../middleware/auth');
const config = require('../config');
const router = express.Router();

// Generate HLS master playlist
router.get('/:contentId/master.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
  try {
    const { contentId } = req.params;

    // Get content info
    const content = await db.query(`
      SELECT id, title, duration, status FROM content WHERE id = $1
    `, [contentId]);

    if (content.rows.length === 0) {
      return res.status(404).send('#EXTM3U\n# Content not found');
    }

    if (content.rows[0].status !== 'ready') {
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

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    console.error('Generate master playlist error:', error);
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Generate variant playlist (video quality level)
router.get('/:contentId/variant/:variantId.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
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

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    console.error('Generate variant playlist error:', error);
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Generate audio playlist
router.get('/:contentId/audio/:audioId.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
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

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    console.error('Generate audio playlist error:', error);
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Generate subtitle playlist
router.get('/:contentId/subtitles/:subId.m3u8', isAuthenticated, hasSubscription, async (req, res) => {
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

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (error) {
    console.error('Generate subtitle playlist error:', error);
    res.status(500).send('#EXTM3U\n# Server error');
  }
});

// Serve video segment (simulated - in production would come from CDN/MinIO)
router.get('/:contentId/segment/:variantId/:segmentNum.ts', isAuthenticated, hasSubscription, async (req, res) => {
  try {
    const { contentId, variantId, segmentNum } = req.params;

    // In a real implementation, this would fetch from MinIO/CDN
    // For demo purposes, we'll return a simple response
    // indicating the segment would be served

    // Log segment access for analytics
    await redis.incr(`segment:${contentId}:${variantId}:${segmentNum}`);

    res.setHeader('Content-Type', 'video/mp2t');
    res.status(200).send(''); // Would send actual segment data
  } catch (error) {
    console.error('Serve segment error:', error);
    res.status(500).send('Server error');
  }
});

// Serve audio segment
router.get('/:contentId/audio-segment/:audioId/:segmentNum.aac', isAuthenticated, hasSubscription, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'audio/aac');
    res.status(200).send(''); // Would send actual audio data
  } catch (error) {
    console.error('Serve audio segment error:', error);
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
    console.error('Serve subtitle error:', error);
    res.status(500).send('Server error');
  }
});

// Get playback URL (used by client to initiate streaming)
router.get('/:contentId/playback', isAuthenticated, hasSubscription, async (req, res) => {
  try {
    const { contentId } = req.params;

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

    res.json({
      manifestUrl: `/api/stream/${contentId}/master.m3u8`,
      playbackToken,
      content: content.rows[0]
    });
  } catch (error) {
    console.error('Get playback URL error:', error);
    res.status(500).json({ error: 'Failed to get playback URL' });
  }
});

module.exports = router;
