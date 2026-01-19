import { Router, Request, Response } from 'express';
import recommendationService from '../services/recommendationService.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimiters } from '../shared/rateLimit.js';
import { recommendationLatency } from '../shared/metrics.js';
import type { AuthenticatedRequest } from '../types.js';

const router = Router();

interface RecommendationsQuery {
  limit?: string;
}

// Get personalized recommendations (requires auth)
router.get('/for-you', requireAuth, rateLimiters.recommendations, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const startTime = Date.now();
  try {
    const { limit = '30' } = req.query as RecommendationsQuery;
    const tracks = await recommendationService.getRecommendations(authReq.session.userId!, {
      limit: parseInt(limit),
    });

    // Record latency
    recommendationLatency.observe({ algorithm: 'for_you' }, (Date.now() - startTime) / 1000);

    res.json({ tracks });
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Get recommendations error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Discover Weekly (requires auth)
router.get('/discover-weekly', requireAuth, rateLimiters.recommendations, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const startTime = Date.now();
  try {
    const tracks = await recommendationService.getDiscoverWeekly(authReq.session.userId!);

    // Record latency
    recommendationLatency.observe({ algorithm: 'discover_weekly' }, (Date.now() - startTime) / 1000);

    res.json({
      name: 'Discover Weekly',
      description: 'Your weekly mixtape of fresh music. Enjoy new discoveries tailored to your taste.',
      tracks,
    });
  } catch (error) {
    const log = authReq.log || console;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: errorMessage }, 'Get discover weekly error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get popular/trending tracks (no auth required)
router.get('/popular', async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = '30' } = req.query as RecommendationsQuery;
    const tracks = await recommendationService.getPopularTracks({
      limit: parseInt(limit),
    });
    res.json({ tracks });
  } catch (error) {
    console.error('Get popular tracks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get similar tracks
router.get('/similar/:trackId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = '20' } = req.query as RecommendationsQuery;
    const tracks = await recommendationService.getSimilarTracks(req.params.trackId, {
      limit: parseInt(limit),
    });
    res.json({ tracks });
  } catch (error) {
    console.error('Get similar tracks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get artist radio
router.get('/radio/artist/:artistId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = '50' } = req.query as RecommendationsQuery;
    const tracks = await recommendationService.getArtistRadio(req.params.artistId, {
      limit: parseInt(limit),
    });
    res.json({ tracks });
  } catch (error) {
    console.error('Get artist radio error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
