import { Router } from 'express';
import recommendationService from '../services/recommendationService.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';

const router = Router();

// Get personalized recommendations (requires auth)
router.get('/for-you', requireAuth, async (req, res) => {
  try {
    const { limit = 30 } = req.query;
    const tracks = await recommendationService.getRecommendations(req.session.userId, {
      limit: parseInt(limit),
    });
    res.json({ tracks });
  } catch (error) {
    console.error('Get recommendations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Discover Weekly (requires auth)
router.get('/discover-weekly', requireAuth, async (req, res) => {
  try {
    const tracks = await recommendationService.getDiscoverWeekly(req.session.userId);
    res.json({
      name: 'Discover Weekly',
      description: 'Your weekly mixtape of fresh music. Enjoy new discoveries tailored to your taste.',
      tracks,
    });
  } catch (error) {
    console.error('Get discover weekly error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get popular/trending tracks (no auth required)
router.get('/popular', async (req, res) => {
  try {
    const { limit = 30 } = req.query;
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
router.get('/similar/:trackId', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
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
router.get('/radio/artist/:artistId', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
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
