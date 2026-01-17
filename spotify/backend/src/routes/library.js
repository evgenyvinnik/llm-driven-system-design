import { Router } from 'express';
import libraryService from '../services/libraryService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All library routes require authentication
router.use(requireAuth);

// Get liked songs
router.get('/tracks', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await libraryService.getLikedSongs(req.session.userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(result);
  } catch (error) {
    console.error('Get liked songs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like a track
router.put('/tracks/:id', async (req, res) => {
  try {
    const result = await libraryService.saveToLibrary(
      req.session.userId,
      'track',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Like track error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unlike a track
router.delete('/tracks/:id', async (req, res) => {
  try {
    const result = await libraryService.removeFromLibrary(
      req.session.userId,
      'track',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Unlike track error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if tracks are liked
router.get('/tracks/contains', async (req, res) => {
  try {
    const { ids } = req.query;
    if (!ids) {
      return res.status(400).json({ error: 'Track IDs required' });
    }
    const trackIds = ids.split(',');
    const result = await libraryService.checkMultipleInLibrary(
      req.session.userId,
      'track',
      trackIds
    );
    res.json(result);
  } catch (error) {
    console.error('Check tracks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get saved albums
router.get('/albums', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await libraryService.getSavedAlbums(req.session.userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(result);
  } catch (error) {
    console.error('Get saved albums error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save album
router.put('/albums/:id', async (req, res) => {
  try {
    const result = await libraryService.saveToLibrary(
      req.session.userId,
      'album',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Save album error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove album
router.delete('/albums/:id', async (req, res) => {
  try {
    const result = await libraryService.removeFromLibrary(
      req.session.userId,
      'album',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Remove album error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get followed artists
router.get('/artists', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await libraryService.getFollowedArtists(req.session.userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(result);
  } catch (error) {
    console.error('Get followed artists error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Follow artist
router.put('/artists/:id', async (req, res) => {
  try {
    const result = await libraryService.saveToLibrary(
      req.session.userId,
      'artist',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Follow artist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unfollow artist
router.delete('/artists/:id', async (req, res) => {
  try {
    const result = await libraryService.removeFromLibrary(
      req.session.userId,
      'artist',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Unfollow artist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get saved playlists (followed, not owned)
router.get('/playlists', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = await libraryService.getSavedPlaylists(req.session.userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(result);
  } catch (error) {
    console.error('Get saved playlists error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Follow playlist
router.put('/playlists/:id', async (req, res) => {
  try {
    const result = await libraryService.saveToLibrary(
      req.session.userId,
      'playlist',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Follow playlist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unfollow playlist
router.delete('/playlists/:id', async (req, res) => {
  try {
    const result = await libraryService.removeFromLibrary(
      req.session.userId,
      'playlist',
      req.params.id
    );
    res.json(result);
  } catch (error) {
    console.error('Unfollow playlist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
