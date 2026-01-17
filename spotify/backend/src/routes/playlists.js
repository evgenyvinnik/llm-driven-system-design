import { Router } from 'express';
import playlistService from '../services/playlistService.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { rateLimiters } from '../shared/rateLimit.js';
import { idempotencyMiddleware, playlistTrackIdempotencyKey } from '../shared/idempotency.js';
import { playlistOperationsTotal } from '../shared/metrics.js';

const router = Router();

// Get public playlists (no auth required)
router.get('/public', async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const result = await playlistService.getPublicPlaylists({
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(result);
  } catch (error) {
    console.error('Get public playlists error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's own playlists
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await playlistService.getUserPlaylists(req.session.userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(result);
  } catch (error) {
    console.error('Get user playlists error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create playlist
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description, isPublic = true } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    const playlist = await playlistService.createPlaylist(req.session.userId, {
      name,
      description,
      isPublic,
    });

    res.status(201).json(playlist);
  } catch (error) {
    console.error('Create playlist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get playlist by ID
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const playlist = await playlistService.getPlaylistById(
      req.params.id,
      req.session?.userId
    );

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    res.json(playlist);
  } catch (error) {
    console.error('Get playlist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update playlist
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const playlist = await playlistService.updatePlaylist(
      req.params.id,
      req.session.userId,
      req.body
    );
    res.json(playlist);
  } catch (error) {
    console.error('Update playlist error:', error);
    if (error.message.includes('Not authorized')) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete playlist
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await playlistService.deletePlaylist(req.params.id, req.session.userId);
    res.json({ deleted: true });
  } catch (error) {
    console.error('Delete playlist error:', error);
    if (error.message.includes('Not authorized')) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add track to playlist (with idempotency)
router.post(
  '/:id/tracks',
  requireAuth,
  rateLimiters.playlistWrite,
  idempotencyMiddleware('playlist_add_track', playlistTrackIdempotencyKey),
  async (req, res) => {
    try {
      const { trackId } = req.body;

      if (!trackId) {
        return res.status(400).json({ error: 'Track ID is required' });
      }

      const result = await playlistService.addTrackToPlaylist(
        req.params.id,
        trackId,
        req.session.userId
      );

      playlistOperationsTotal.inc({ operation: 'add_track' });

      res.json(result);
    } catch (error) {
      const log = req.log || console;
      log.error({ error: error.message, playlistId: req.params.id }, 'Add track to playlist error');
      if (error.message.includes('Not authorized')) {
        return res.status(403).json({ error: error.message });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Remove track from playlist (with idempotency)
router.delete(
  '/:id/tracks/:trackId',
  requireAuth,
  rateLimiters.playlistWrite,
  idempotencyMiddleware('playlist_remove_track', playlistTrackIdempotencyKey),
  async (req, res) => {
    try {
      const result = await playlistService.removeTrackFromPlaylist(
        req.params.id,
        req.params.trackId,
        req.session.userId
      );

      playlistOperationsTotal.inc({ operation: 'remove_track' });

      res.json(result);
    } catch (error) {
      const log = req.log || console;
      log.error({ error: error.message, playlistId: req.params.id }, 'Remove track from playlist error');
      if (error.message.includes('Not authorized')) {
        return res.status(403).json({ error: error.message });
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Reorder playlist tracks
router.put('/:id/tracks/reorder', requireAuth, async (req, res) => {
  try {
    const { trackId, newPosition } = req.body;

    if (!trackId || newPosition === undefined) {
      return res.status(400).json({ error: 'Track ID and new position are required' });
    }

    const result = await playlistService.reorderPlaylistTracks(
      req.params.id,
      req.session.userId,
      { trackId, newPosition }
    );

    res.json(result);
  } catch (error) {
    console.error('Reorder playlist tracks error:', error);
    if (error.message.includes('Not authorized')) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
