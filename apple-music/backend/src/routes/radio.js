import { Router } from 'express';
import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { optionalAuth, authenticate } from '../middleware/auth.js';

const router = Router();

// Get all radio stations
router.get('/', optionalAuth, async (req, res) => {
  try {
    const cacheKey = 'radio:stations';
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const result = await pool.query(
      `SELECT rs.*, a.name as seed_artist_name
       FROM radio_stations rs
       LEFT JOIN artists a ON rs.seed_artist_id = a.id
       WHERE rs.is_active = true
       ORDER BY rs.name`
    );

    const response = { stations: result.rows };
    await redis.setex(cacheKey, 300, JSON.stringify(response));

    res.json(response);
  } catch (error) {
    console.error('Get radio stations error:', error);
    res.status(500).json({ error: 'Failed to fetch radio stations' });
  }
});

// Get radio station details with tracks
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const stationResult = await pool.query(
      `SELECT rs.*, a.name as seed_artist_name
       FROM radio_stations rs
       LEFT JOIN artists a ON rs.seed_artist_id = a.id
       WHERE rs.id = $1`,
      [id]
    );

    if (stationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Radio station not found' });
    }

    // Get station tracks
    const tracksResult = await pool.query(
      `SELECT rst.position, t.*, ar.name as artist_name, al.title as album_title, al.artwork_url
       FROM radio_station_tracks rst
       JOIN tracks t ON rst.track_id = t.id
       JOIN artists ar ON t.artist_id = ar.id
       JOIN albums al ON t.album_id = al.id
       WHERE rst.station_id = $1
       ORDER BY rst.position`,
      [id]
    );

    res.json({
      ...stationResult.rows[0],
      tracks: tracksResult.rows
    });
  } catch (error) {
    console.error('Get radio station error:', error);
    res.status(500).json({ error: 'Failed to fetch radio station' });
  }
});

// Get tracks for a radio station (with shuffle option)
router.get('/:id/tracks', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { shuffle = 'false', limit = 25 } = req.query;

    const station = await pool.query(
      'SELECT * FROM radio_stations WHERE id = $1',
      [id]
    );

    if (station.rows.length === 0) {
      return res.status(404).json({ error: 'Radio station not found' });
    }

    let tracksQuery;
    let tracksParams;

    if (station.rows[0].type === 'curated') {
      // Get curated tracks
      tracksQuery = `
        SELECT rst.position, t.*, ar.name as artist_name, al.title as album_title, al.artwork_url
        FROM radio_station_tracks rst
        JOIN tracks t ON rst.track_id = t.id
        JOIN artists ar ON t.artist_id = ar.id
        JOIN albums al ON t.album_id = al.id
        WHERE rst.station_id = $1
        ${shuffle === 'true' ? 'ORDER BY RANDOM()' : 'ORDER BY rst.position'}
        LIMIT $2
      `;
      tracksParams = [id, parseInt(limit)];
    } else if (station.rows[0].type === 'genre') {
      // Get tracks by genre
      tracksQuery = `
        SELECT t.*, ar.name as artist_name, al.title as album_title, al.artwork_url
        FROM tracks t
        JOIN artists ar ON t.artist_id = ar.id
        JOIN albums al ON t.album_id = al.id
        JOIN track_genres tg ON t.id = tg.track_id
        WHERE LOWER(tg.genre) = LOWER($1)
        ${shuffle === 'true' ? 'ORDER BY RANDOM()' : 'ORDER BY t.play_count DESC'}
        LIMIT $2
      `;
      tracksParams = [station.rows[0].seed_genre, parseInt(limit)];
    } else if (station.rows[0].type === 'artist') {
      // Get tracks by artist and similar artists
      tracksQuery = `
        SELECT t.*, ar.name as artist_name, al.title as album_title, al.artwork_url
        FROM tracks t
        JOIN artists ar ON t.artist_id = ar.id
        JOIN albums al ON t.album_id = al.id
        WHERE t.artist_id = $1
        ${shuffle === 'true' ? 'ORDER BY RANDOM()' : 'ORDER BY t.play_count DESC'}
        LIMIT $2
      `;
      tracksParams = [station.rows[0].seed_artist_id, parseInt(limit)];
    } else {
      // Generic fallback
      tracksQuery = `
        SELECT t.*, ar.name as artist_name, al.title as album_title, al.artwork_url
        FROM tracks t
        JOIN artists ar ON t.artist_id = ar.id
        JOIN albums al ON t.album_id = al.id
        ORDER BY RANDOM()
        LIMIT $1
      `;
      tracksParams = [parseInt(limit)];
    }

    const result = await pool.query(tracksQuery, tracksParams);

    res.json({ tracks: result.rows });
  } catch (error) {
    console.error('Get radio tracks error:', error);
    res.status(500).json({ error: 'Failed to fetch radio tracks' });
  }
});

// Create personal radio station (based on a seed track or artist)
router.post('/personal', authenticate, async (req, res) => {
  try {
    const { seedType, seedId, name } = req.body;
    const userId = req.user.id;

    if (!seedType || !seedId) {
      return res.status(400).json({ error: 'Seed type and ID required' });
    }

    let stationName = name;
    let seedArtistId = null;
    let seedGenre = null;

    if (seedType === 'artist') {
      const artist = await pool.query('SELECT name FROM artists WHERE id = $1', [seedId]);
      if (artist.rows.length === 0) {
        return res.status(404).json({ error: 'Artist not found' });
      }
      stationName = stationName || `${artist.rows[0].name} Radio`;
      seedArtistId = seedId;
    } else if (seedType === 'track') {
      const track = await pool.query(
        `SELECT t.title, a.name as artist_name, a.id as artist_id
         FROM tracks t
         JOIN artists a ON t.artist_id = a.id
         WHERE t.id = $1`,
        [seedId]
      );
      if (track.rows.length === 0) {
        return res.status(404).json({ error: 'Track not found' });
      }
      stationName = stationName || `${track.rows[0].title} Radio`;
      seedArtistId = track.rows[0].artist_id;

      // Get genre from track
      const genreResult = await pool.query(
        'SELECT genre FROM track_genres WHERE track_id = $1 ORDER BY weight DESC LIMIT 1',
        [seedId]
      );
      if (genreResult.rows.length > 0) {
        seedGenre = genreResult.rows[0].genre;
      }
    } else if (seedType === 'genre') {
      stationName = stationName || `${seedId} Radio`;
      seedGenre = seedId;
    }

    // Create the station
    const result = await pool.query(
      `INSERT INTO radio_stations (name, type, seed_artist_id, seed_genre)
       VALUES ($1, 'personal', $2, $3)
       RETURNING *`,
      [stationName, seedArtistId, seedGenre]
    );

    const station = result.rows[0];

    // Generate tracks for the station
    let tracksQuery;
    let tracksParams;

    if (seedGenre) {
      tracksQuery = `
        SELECT t.id FROM tracks t
        JOIN track_genres tg ON t.id = tg.track_id
        WHERE LOWER(tg.genre) = LOWER($1)
        ORDER BY RANDOM()
        LIMIT 25
      `;
      tracksParams = [seedGenre];
    } else if (seedArtistId) {
      tracksQuery = `
        SELECT t.id FROM tracks t
        WHERE t.artist_id = $1
        ORDER BY t.play_count DESC, RANDOM()
        LIMIT 25
      `;
      tracksParams = [seedArtistId];
    } else {
      tracksQuery = 'SELECT id FROM tracks ORDER BY RANDOM() LIMIT 25';
      tracksParams = [];
    }

    const tracksResult = await pool.query(tracksQuery, tracksParams);

    // Insert tracks into station
    for (let i = 0; i < tracksResult.rows.length; i++) {
      await pool.query(
        'INSERT INTO radio_station_tracks (station_id, track_id, position) VALUES ($1, $2, $3)',
        [station.id, tracksResult.rows[i].id, i + 1]
      );
    }

    res.status(201).json({
      ...station,
      trackCount: tracksResult.rows.length
    });
  } catch (error) {
    console.error('Create personal radio error:', error);
    res.status(500).json({ error: 'Failed to create radio station' });
  }
});

// Get stations by genre
router.get('/genre/:genre', optionalAuth, async (req, res) => {
  try {
    const { genre } = req.params;

    const result = await pool.query(
      `SELECT * FROM radio_stations
       WHERE type = 'genre' AND LOWER(seed_genre) = LOWER($1) AND is_active = true`,
      [genre]
    );

    res.json({ stations: result.rows });
  } catch (error) {
    console.error('Get genre stations error:', error);
    res.status(500).json({ error: 'Failed to fetch stations' });
  }
});

export default router;
