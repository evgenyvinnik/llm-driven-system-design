import { Router, Request, Response } from 'express';
import playbackService from '../services/playbackService.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimiters } from '../shared/rateLimit.js';
import { playbackEventsTotal, streamCountsTotal, activeStreams } from '../shared/metrics.js';
import type { AuthenticatedRequest, PlaybackEventType, PlaybackState, _isPlaybackEventType } from '../types.js';

const router = Router();

interface PlaybackQuery {
  limit?: string;
}

interface PlaybackEventBody {
  trackId?: string;
  eventType?: string;
  positionMs?: number;
  deviceType?: string;
}

const VALID_EVENTS: PlaybackEventType[] = [
  'play_started',
  'play_paused',
  'play_resumed',
  'play_completed',
  'stream_counted',
  'seeked',
  'skipped',
];

// All playback routes require authentication
router.use(requireAuth);

// Get stream URL for a track (with rate limiting)
router.get('/stream/:trackId', rateLimiters.playback, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const streamInfo = await playbackService.getStreamUrl(
      req.params.trackId,
      authReq.session.userId!
    );
    res.json(streamInfo);
  } catch (error) {
    console.error('Get stream URL error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage === 'Track not found') {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Record playback event
router.post('/event', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { trackId, eventType, positionMs, deviceType } = req.body as PlaybackEventBody;

    if (!trackId || !eventType) {
      res.status(400).json({ error: 'Track ID and event type are required' });
      return;
    }

    if (!VALID_EVENTS.includes(eventType as PlaybackEventType)) {
      res.status(400).json({ error: 'Invalid event type' });
      return;
    }

    const result = await playbackService.recordPlaybackEvent(
      authReq.session.userId!,
      trackId,
      eventType as PlaybackEventType,
      positionMs || 0,
      deviceType || 'web'
    );

    // Track metrics
    playbackEventsTotal.inc({ event_type: eventType, device_type: deviceType || 'web' });

    // Track active streams
    if (eventType === 'play_started' || eventType === 'play_resumed') {
      activeStreams.inc();
    } else if (eventType === 'play_paused' || eventType === 'play_completed' || eventType === 'skipped') {
      activeStreams.dec();
    }

    // Track stream counts (30 second threshold)
    if (eventType === 'stream_counted') {
      streamCountsTotal.inc();
    }

    res.json(result);
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Record playback event error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get recently played
router.get('/recently-played', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { limit = '50' } = req.query as PlaybackQuery;
    const tracks = await playbackService.getRecentlyPlayed(authReq.session.userId!, {
      limit: parseInt(limit),
    });
    res.json({ tracks });
  } catch (error) {
    console.error('Get recently played error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save playback state (for cross-device sync)
router.put('/state', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { trackId, position, isPlaying, queue, shuffleEnabled, repeatMode } = req.body as PlaybackState;

    const result = await playbackService.savePlaybackState(authReq.session.userId!, {
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
router.get('/state', async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const state = await playbackService.getPlaybackState(authReq.session.userId!);
    res.json(state || {});
  } catch (error) {
    console.error('Get playback state error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get track statistics
router.get('/stats/:trackId', async (req: Request, res: Response): Promise<void> => {
  try {
    const stats = await playbackService.getTrackStats(req.params.trackId);
    res.json(stats);
  } catch (error) {
    console.error('Get track stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
