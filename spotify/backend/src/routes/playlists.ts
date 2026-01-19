import { Router, Request, Response } from 'express';
import playlistService from '../services/playlistService.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { rateLimiters } from '../shared/rateLimit.js';
import { idempotencyMiddleware, playlistTrackIdempotencyKey } from '../shared/idempotency.js';
import { playlistOperationsTotal } from '../shared/metrics.js';
import type { AuthenticatedRequest, PlaylistCreate, ReorderRequest } from '../types.js';

const router = Router();

interface PlaylistQuery {
  limit?: string;
  offset?: string;
}

// Get public playlists (no auth required)
router.get('/public', async (req: Request, res: Response): Promise<void> => {
  try {
    const { limit = '20', offset = '0' } = req.query as PlaylistQuery;
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
router.get('/me', requireAuth, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { limit = '50', offset = '0' } = req.query as PlaylistQuery;
    const result = await playlistService.getUserPlaylists(authReq.session.userId!, {
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
router.post('/', requireAuth, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { name, description, isPublic = true } = req.body as PlaylistCreate & { isPublic?: boolean };

    if (!name) {
      res.status(400).json({ error: 'Playlist name is required' });
      return;
    }

    const playlist = await playlistService.createPlaylist(authReq.session.userId!, {
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
router.get('/:id', optionalAuth, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const playlist = await playlistService.getPlaylistById(
      req.params.id,
      authReq.session?.userId || null
    );

    if (!playlist) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }

    res.json(playlist);
  } catch (error) {
    console.error('Get playlist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update playlist
router.patch('/:id', requireAuth, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const playlist = await playlistService.updatePlaylist(
      req.params.id,
      authReq.session.userId!,
      req.body
    );
    res.json(playlist);
  } catch (error) {
    console.error('Update playlist error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('Not authorized')) {
      res.status(403).json({ error: errorMessage });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete playlist
router.delete('/:id', requireAuth, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    await playlistService.deletePlaylist(req.params.id, authReq.session.userId!);
    res.json({ deleted: true });
  } catch (error) {
    console.error('Delete playlist error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('Not authorized')) {
      res.status(403).json({ error: errorMessage });
      return;
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
  async (req, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    try {
      const { trackId } = req.body as { trackId?: string };

      if (!trackId) {
        res.status(400).json({ error: 'Track ID is required' });
        return;
      }

      const result = await playlistService.addTrackToPlaylist(
        req.params.id,
        trackId,
        authReq.session.userId!
      );

      playlistOperationsTotal.inc({ operation: 'add_track' });

      res.json(result);
    } catch (error) {
      const log = authReq.log || console;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMessage, playlistId: req.params.id }, 'Add track to playlist error');
      if (errorMessage.includes('Not authorized')) {
        res.status(403).json({ error: errorMessage });
        return;
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
  async (req, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    try {
      const result = await playlistService.removeTrackFromPlaylist(
        req.params.id,
        req.params.trackId,
        authReq.session.userId!
      );

      playlistOperationsTotal.inc({ operation: 'remove_track' });

      res.json(result);
    } catch (error) {
      const log = authReq.log || console;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMessage, playlistId: req.params.id }, 'Remove track from playlist error');
      if (errorMessage.includes('Not authorized')) {
        res.status(403).json({ error: errorMessage });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Reorder playlist tracks
router.put('/:id/tracks/reorder', requireAuth, async (req, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { trackId, newPosition } = req.body as ReorderRequest;

    if (!trackId || newPosition === undefined) {
      res.status(400).json({ error: 'Track ID and new position are required' });
      return;
    }

    const result = await playlistService.reorderPlaylistTracks(
      req.params.id,
      authReq.session.userId!,
      { trackId, newPosition }
    );

    res.json(result);
  } catch (error) {
    console.error('Reorder playlist tracks error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage.includes('Not authorized')) {
      res.status(403).json({ error: errorMessage });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
