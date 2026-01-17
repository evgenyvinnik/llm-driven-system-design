import { Router } from 'express';
import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { optionalAuth } from '../middleware/auth.js';

const router = Router();

// Search catalog
router.get('/search', optionalAuth, async (req, res) => {
  try {
    const { q, type = 'all', limit = 20, offset = 0 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const searchTerm = `%${q.toLowerCase()}%`;
    const results = { tracks: [], albums: [], artists: [] };

    if (type === 'all' || type === 'tracks') {
      const tracks = await pool.query(
        `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
         FROM tracks t
         JOIN artists a ON t.artist_id = a.id
         JOIN albums al ON t.album_id = al.id
         WHERE LOWER(t.title) LIKE $1 OR LOWER(a.name) LIKE $1
         ORDER BY t.play_count DESC
         LIMIT $2 OFFSET $3`,
        [searchTerm, parseInt(limit), parseInt(offset)]
      );
      results.tracks = tracks.rows;
    }

    if (type === 'all' || type === 'albums') {
      const albums = await pool.query(
        `SELECT al.*, a.name as artist_name
         FROM albums al
         JOIN artists a ON al.artist_id = a.id
         WHERE LOWER(al.title) LIKE $1 OR LOWER(a.name) LIKE $1
         ORDER BY al.release_date DESC
         LIMIT $2 OFFSET $3`,
        [searchTerm, parseInt(limit), parseInt(offset)]
      );
      results.albums = albums.rows;
    }

    if (type === 'all' || type === 'artists') {
      const artists = await pool.query(
        `SELECT * FROM artists
         WHERE LOWER(name) LIKE $1
         ORDER BY verified DESC, name ASC
         LIMIT $2 OFFSET $3`,
        [searchTerm, parseInt(limit), parseInt(offset)]
      );
      results.artists = artists.rows;
    }

    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get all tracks with pagination
router.get('/tracks', optionalAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, sort = 'created_at', order = 'desc' } = req.query;

    const cacheKey = `tracks:${limit}:${offset}:${sort}:${order}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const validSort = ['created_at', 'title', 'play_count', 'duration_ms'].includes(sort) ? sort : 'created_at';
    const validOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const result = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       ORDER BY t.${validSort} ${validOrder}
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM tracks');

    const response = {
      tracks: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    await redis.setex(cacheKey, 300, JSON.stringify(response)); // Cache 5 minutes

    res.json(response);
  } catch (error) {
    console.error('Get tracks error:', error);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// Get single track
router.get('/tracks/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT t.*, a.name as artist_name, a.id as artist_id,
              al.title as album_title, al.id as album_id, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE t.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Track not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get track error:', error);
    res.status(500).json({ error: 'Failed to fetch track' });
  }
});

// Get all albums
router.get('/albums', optionalAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, sort = 'release_date', order = 'desc' } = req.query;

    const cacheKey = `albums:${limit}:${offset}:${sort}:${order}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const validSort = ['release_date', 'title', 'created_at'].includes(sort) ? sort : 'release_date';
    const validOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const result = await pool.query(
      `SELECT al.*, a.name as artist_name
       FROM albums al
       JOIN artists a ON al.artist_id = a.id
       ORDER BY al.${validSort} ${validOrder}
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM albums');

    const response = {
      albums: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    await redis.setex(cacheKey, 300, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    console.error('Get albums error:', error);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

// Get single album with tracks
router.get('/albums/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const albumResult = await pool.query(
      `SELECT al.*, a.name as artist_name, a.id as artist_id
       FROM albums al
       JOIN artists a ON al.artist_id = a.id
       WHERE al.id = $1`,
      [id]
    );

    if (albumResult.rows.length === 0) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const tracksResult = await pool.query(
      `SELECT t.*, a.name as artist_name
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       WHERE t.album_id = $1
       ORDER BY t.disc_number, t.track_number`,
      [id]
    );

    res.json({
      ...albumResult.rows[0],
      tracks: tracksResult.rows
    });
  } catch (error) {
    console.error('Get album error:', error);
    res.status(500).json({ error: 'Failed to fetch album' });
  }
});

// Get all artists
router.get('/artists', optionalAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, sort = 'name', order = 'asc' } = req.query;

    const cacheKey = `artists:${limit}:${offset}:${sort}:${order}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const validSort = ['name', 'created_at'].includes(sort) ? sort : 'name';
    const validOrder = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const result = await pool.query(
      `SELECT * FROM artists
       ORDER BY ${validSort} ${validOrder}
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM artists');

    const response = {
      artists: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    await redis.setex(cacheKey, 300, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    console.error('Get artists error:', error);
    res.status(500).json({ error: 'Failed to fetch artists' });
  }
});

// Get single artist with albums
router.get('/artists/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const artistResult = await pool.query(
      'SELECT * FROM artists WHERE id = $1',
      [id]
    );

    if (artistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    const albumsResult = await pool.query(
      `SELECT * FROM albums
       WHERE artist_id = $1
       ORDER BY release_date DESC`,
      [id]
    );

    // Get top tracks
    const topTracksResult = await pool.query(
      `SELECT t.*, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN albums al ON t.album_id = al.id
       WHERE t.artist_id = $1
       ORDER BY t.play_count DESC
       LIMIT 10`,
      [id]
    );

    res.json({
      ...artistResult.rows[0],
      albums: albumsResult.rows,
      topTracks: topTracksResult.rows
    });
  } catch (error) {
    console.error('Get artist error:', error);
    res.status(500).json({ error: 'Failed to fetch artist' });
  }
});

// Get genres
router.get('/genres', optionalAuth, async (req, res) => {
  try {
    const cacheKey = 'genres:all';
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await pool.query(
      `SELECT DISTINCT genre, COUNT(*) as track_count
       FROM track_genres
       GROUP BY genre
       ORDER BY track_count DESC`
    );

    const response = { genres: result.rows };
    await redis.setex(cacheKey, 3600, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    console.error('Get genres error:', error);
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

// Get tracks by genre
router.get('/genres/:genre/tracks', optionalAuth, async (req, res) => {
  try {
    const { genre } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM tracks t
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       JOIN track_genres tg ON t.id = tg.track_id
       WHERE LOWER(tg.genre) = LOWER($1)
       ORDER BY t.play_count DESC
       LIMIT $2 OFFSET $3`,
      [genre, parseInt(limit), parseInt(offset)]
    );

    res.json({ tracks: result.rows });
  } catch (error) {
    console.error('Get genre tracks error:', error);
    res.status(500).json({ error: 'Failed to fetch genre tracks' });
  }
});

export default router;
