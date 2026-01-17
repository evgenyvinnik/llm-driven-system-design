import { Router } from 'express';
import playbackService from '../services/playbackService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All playback routes require authentication
router.use(requireAuth);

// Get stream URL for a track
router.get('/stream/:trackId', async (req, res) => {
  try {
    const streamInfo = await playbackService.getStreamUrl(
      req.params.trackId,
      req.session.userId
    );
    res.json(streamInfo);
  } catch (error) {
    console.error('Get stream URL error:', error);
    if (error.message === 'Track not found') {
      return res.status(404).json({ error: 'Track not found' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Record playback event
router.post('/event', async (req, res) => {
  try {
    const { trackId, eventType, positionMs, deviceType } = req.body;

    if (!trackId || !eventType) {
      return res.status(400).json({ error: 'Track ID and event type are required' });
    }

    const validEvents = ['play_started', 'play_paused', 'play_resumed', 'play_completed', 'stream_counted', 'seeked', 'skipped'];
    if (!validEvents.includes(eventType)) {
      return res.status(400).json({ error: 'Invalid event type' });
    }

    const result = await playbackService.recordPlaybackEvent(
      req.session.userId,
      trackId,
      eventType,
      positionMs || 0,
      deviceType || 'web'
    );

    res.json(result);
  } catch (error) {
    console.error('Record playback event error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get recently played
router.get('/recently-played', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const tracks = await playbackService.getRecentlyPlayed(req.session.userId, {
      limit: parseInt(limit),
    });
    res.json({ tracks });
  } catch (error) {
    console.error('Get recently played error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save playback state (for cross-device sync)
router.put('/state', async (req, res) => {
  try {
    const { trackId, position, isPlaying, queue, shuffleEnabled, repeatMode } = req.body;

    const result = await playbackService.savePlaybackState(req.session.userId, {
      trackId,
      position,
      isPlaying,
      queue,
      shuffleEnabled,
      repeatMode,
      updatedAt: Date.now(),
    });

    res.json(result);
  } catch (error) {
    console.error('Save playback state error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get playback state
router.get('/state', async (req, res) => {
  try {
    const state = await playbackService.getPlaybackState(req.session.userId);
    res.json(state || {});
  } catch (error) {
    console.error('Get playback state error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get track statistics
router.get('/stats/:trackId', async (req, res) => {
  try {
    const stats = await playbackService.getTrackStats(req.params.trackId);
    res.json(stats);
  } catch (error) {
    console.error('Get track stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
