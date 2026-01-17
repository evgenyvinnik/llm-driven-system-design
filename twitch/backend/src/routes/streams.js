const express = require('express');
const { query } = require('../services/database');
const { getSession } = require('../services/redis');
const { generateHLSManifest, generateMasterPlaylist, startStream, endStream } = require('../services/streamSimulator');

const router = express.Router();

// Get stream info
router.get('/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;

    const result = await query(`
      SELECT s.id, s.title, s.started_at, s.peak_viewers, s.total_views,
             c.name as channel_name, c.is_live, c.current_viewers,
             cat.name as category_name, cat.slug as category_slug
      FROM streams s
      JOIN channels c ON s.channel_id = c.id
      LEFT JOIN categories cat ON s.category_id = cat.id
      WHERE s.channel_id = $1 AND s.ended_at IS NULL
      ORDER BY s.started_at DESC
      LIMIT 1
    `, [channelId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active stream found' });
    }

    const row = result.rows[0];
    res.json({
      stream: {
        id: row.id,
        title: row.title,
        startedAt: row.started_at,
        peakViewers: row.peak_viewers,
        totalViews: row.total_views,
        channelName: row.channel_name,
        isLive: row.is_live,
        viewerCount: row.current_viewers,
        category: row.category_name ? {
          name: row.category_name,
          slug: row.category_slug
        } : null
      }
    });
  } catch (error) {
    console.error('Get stream error:', error);
    res.status(500).json({ error: 'Failed to get stream' });
  }
});

// Get HLS master playlist
router.get('/:channelId/master.m3u8', (req, res) => {
  const { channelId } = req.params;
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(generateMasterPlaylist(channelId));
});

// Get HLS playlist for specific quality
router.get('/:channelId/playlist_:quality.m3u8', (req, res) => {
  const { channelId } = req.params;
  res.set('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(generateHLSManifest(channelId));
});

// Simulated video segment - returns placeholder
router.get('/:channelId/segments/:segment', (req, res) => {
  // In production, this would serve actual video segments
  // For demo, we return a 204 to indicate segment exists
  res.status(204).send();
});

// Start streaming (for channel owner)
router.post('/start', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { title, categoryId } = req.body;

    // Get user's channel
    const channelResult = await query(
      'SELECT id FROM channels WHERE user_id = $1',
      [userId]
    );

    if (channelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channelId = channelResult.rows[0].id;
    const stream = await startStream(channelId, title || 'Live Stream', categoryId);

    res.json({ success: true, streamId: stream.id });
  } catch (error) {
    console.error('Start stream error:', error);
    res.status(500).json({ error: 'Failed to start stream' });
  }
});

// Stop streaming (for channel owner)
router.post('/stop', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Session expired' });
    }

    // Get user's channel
    const channelResult = await query(
      'SELECT id FROM channels WHERE user_id = $1',
      [userId]
    );

    if (channelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channelId = channelResult.rows[0].id;
    await endStream(channelId);

    res.json({ success: true });
  } catch (error) {
    console.error('Stop stream error:', error);
    res.status(500).json({ error: 'Failed to stop stream' });
  }
});

// Get past streams (VODs)
router.get('/:channelId/vods', async (req, res) => {
  try {
    const { channelId } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    const result = await query(`
      SELECT s.id, s.title, s.started_at, s.ended_at, s.peak_viewers,
             s.total_views, s.thumbnail_url, s.vod_url,
             cat.name as category_name, cat.slug as category_slug
      FROM streams s
      LEFT JOIN categories cat ON s.category_id = cat.id
      WHERE s.channel_id = $1 AND s.ended_at IS NOT NULL
      ORDER BY s.started_at DESC
      LIMIT $2 OFFSET $3
    `, [channelId, parseInt(limit), parseInt(offset)]);

    res.json({
      vods: result.rows.map(row => ({
        id: row.id,
        title: row.title,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        duration: row.ended_at && row.started_at
          ? Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 1000)
          : null,
        peakViewers: row.peak_viewers,
        totalViews: row.total_views,
        thumbnailUrl: row.thumbnail_url,
        vodUrl: row.vod_url,
        category: row.category_name ? {
          name: row.category_name,
          slug: row.category_slug
        } : null
      }))
    });
  } catch (error) {
    console.error('Get VODs error:', error);
    res.status(500).json({ error: 'Failed to get VODs' });
  }
});

module.exports = router;
