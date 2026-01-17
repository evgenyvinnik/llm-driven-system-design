const express = require('express');
const db = require('../db');
const { client: redis } = require('../db/redis');
const { isAuthenticated } = require('../middleware/auth');
const router = express.Router();

// Get all content (browse)
router.get('/', async (req, res) => {
  try {
    const { type, genre, search, limit = 20, offset = 0 } = req.query;

    let query = `
      SELECT id, title, description, duration, release_date, content_type,
             series_id, season_number, episode_number, rating, genres,
             thumbnail_url, banner_url, status, featured, view_count
      FROM content
      WHERE status = 'ready' AND content_type != 'episode'
    `;
    const params = [];
    let paramIndex = 1;

    if (type) {
      query += ` AND content_type = $${paramIndex++}`;
      params.push(type);
    }

    if (genre) {
      query += ` AND $${paramIndex++} = ANY(genres)`;
      params.push(genre);
    }

    if (search) {
      query += ` AND (title ILIKE $${paramIndex++} OR description ILIKE $${paramIndex++})`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY featured DESC, release_date DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json(result.rows);
  } catch (error) {
    console.error('Get content error:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Get featured content
router.get('/featured', async (req, res) => {
  try {
    // Try cache first
    const cached = await redis.get('content:featured');
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await db.query(`
      SELECT id, title, description, duration, release_date, content_type,
             rating, genres, thumbnail_url, banner_url
      FROM content
      WHERE status = 'ready' AND featured = true AND content_type != 'episode'
      ORDER BY release_date DESC
      LIMIT 10
    `);

    // Cache for 5 minutes
    await redis.setEx('content:featured', 300, JSON.stringify(result.rows));

    res.json(result.rows);
  } catch (error) {
    console.error('Get featured error:', error);
    res.status(500).json({ error: 'Failed to fetch featured content' });
  }
});

// Get content by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT id, title, description, duration, release_date, content_type,
             series_id, season_number, episode_number, rating, genres,
             thumbnail_url, banner_url, master_resolution, hdr_format, status, view_count
      FROM content
      WHERE id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    const content = result.rows[0];

    // If it's a series, get episodes
    if (content.content_type === 'series') {
      const episodes = await db.query(`
        SELECT id, title, description, duration, season_number, episode_number,
               thumbnail_url, rating
        FROM content
        WHERE series_id = $1 AND content_type = 'episode'
        ORDER BY season_number, episode_number
      `, [id]);

      content.episodes = episodes.rows;

      // Group by season
      const seasons = {};
      for (const episode of episodes.rows) {
        if (!seasons[episode.season_number]) {
          seasons[episode.season_number] = [];
        }
        seasons[episode.season_number].push(episode);
      }
      content.seasons = seasons;
    }

    // Get encoded variants
    const variants = await db.query(`
      SELECT id, resolution, codec, hdr, bitrate
      FROM encoded_variants
      WHERE content_id = $1
      ORDER BY resolution DESC, bitrate DESC
    `, [id]);

    content.variants = variants.rows;

    // Get audio tracks
    const audioTracks = await db.query(`
      SELECT id, language, name, codec, channels
      FROM audio_tracks
      WHERE content_id = $1
    `, [id]);

    content.audioTracks = audioTracks.rows;

    // Get subtitles
    const subtitles = await db.query(`
      SELECT id, language, name, type
      FROM subtitles
      WHERE content_id = $1
    `, [id]);

    content.subtitles = subtitles.rows;

    res.json(content);
  } catch (error) {
    console.error('Get content by ID error:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Get series details with all seasons
router.get('/:id/seasons', async (req, res) => {
  try {
    const { id } = req.params;

    const episodes = await db.query(`
      SELECT id, title, description, duration, season_number, episode_number,
             thumbnail_url, rating
      FROM content
      WHERE series_id = $1 AND content_type = 'episode'
      ORDER BY season_number, episode_number
    `, [id]);

    // Group by season
    const seasons = {};
    for (const episode of episodes.rows) {
      if (!seasons[episode.season_number]) {
        seasons[episode.season_number] = [];
      }
      seasons[episode.season_number].push(episode);
    }

    res.json(seasons);
  } catch (error) {
    console.error('Get seasons error:', error);
    res.status(500).json({ error: 'Failed to fetch seasons' });
  }
});

// Get genres
router.get('/meta/genres', async (req, res) => {
  try {
    const cached = await redis.get('content:genres');
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await db.query(`
      SELECT DISTINCT unnest(genres) as genre
      FROM content
      WHERE status = 'ready'
      ORDER BY genre
    `);

    const genres = result.rows.map(r => r.genre);

    await redis.setEx('content:genres', 3600, JSON.stringify(genres));

    res.json(genres);
  } catch (error) {
    console.error('Get genres error:', error);
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

// Increment view count
router.post('/:id/view', async (req, res) => {
  try {
    const { id } = req.params;

    await db.query(`
      UPDATE content SET view_count = view_count + 1 WHERE id = $1
    `, [id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Increment view error:', error);
    res.status(500).json({ error: 'Failed to increment view' });
  }
});

module.exports = router;
