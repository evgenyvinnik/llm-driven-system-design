import { Router } from 'express';
import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireAdmin);

// Dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const cacheKey = 'admin:stats';
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const [users, tracks, albums, artists, playlists, plays] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM tracks'),
      pool.query('SELECT COUNT(*) as count FROM albums'),
      pool.query('SELECT COUNT(*) as count FROM artists'),
      pool.query('SELECT COUNT(*) as count FROM playlists'),
      pool.query('SELECT COUNT(*) as count FROM listening_history')
    ]);

    // Active users (last 7 days)
    const activeUsers = await pool.query(
      `SELECT COUNT(DISTINCT user_id) as count FROM listening_history
       WHERE played_at > NOW() - INTERVAL '7 days'`
    );

    // Plays per day (last 7 days)
    const playsPerDay = await pool.query(
      `SELECT DATE(played_at) as date, COUNT(*) as plays
       FROM listening_history
       WHERE played_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(played_at)
       ORDER BY date DESC`
    );

    // Top tracks today
    const topTracksToday = await pool.query(
      `SELECT t.id, t.title, a.name as artist_name, COUNT(lh.id) as plays
       FROM listening_history lh
       JOIN tracks t ON lh.track_id = t.id
       JOIN artists a ON t.artist_id = a.id
       WHERE lh.played_at > NOW() - INTERVAL '1 day'
       GROUP BY t.id, a.name
       ORDER BY plays DESC
       LIMIT 10`
    );

    const stats = {
      counts: {
        users: parseInt(users.rows[0].count),
        tracks: parseInt(tracks.rows[0].count),
        albums: parseInt(albums.rows[0].count),
        artists: parseInt(artists.rows[0].count),
        playlists: parseInt(playlists.rows[0].count),
        totalPlays: parseInt(plays.rows[0].count)
      },
      activeUsers: parseInt(activeUsers.rows[0].count),
      playsPerDay: playsPerDay.rows,
      topTracksToday: topTracksToday.rows
    };

    await redis.setex(cacheKey, 300, JSON.stringify(stats));

    res.json(stats);
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT id, email, username, display_name, role, subscription_tier,
              created_at, updated_at
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM users');

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update user
router.patch('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { role, subscriptionTier } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (role) {
      updates.push(`role = $${paramCount++}`);
      values.push(role);
    }
    if (subscriptionTier) {
      updates.push(`subscription_tier = $${paramCount++}`);
      values.push(subscriptionTier);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, email, username, display_name, role, subscription_tier`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Add new artist
router.post('/artists', async (req, res) => {
  try {
    const { name, bio, imageUrl, genres, verified } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Artist name required' });
    }

    const result = await pool.query(
      `INSERT INTO artists (name, bio, image_url, genres, verified)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, bio || '', imageUrl || '', genres || [], verified || false]
    );

    // Invalidate cache
    await redis.del('artists:*');

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Add artist error:', error);
    res.status(500).json({ error: 'Failed to add artist' });
  }
});

// Update artist
router.patch('/artists/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, bio, imageUrl, genres, verified } = req.body;

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (bio !== undefined) {
      updates.push(`bio = $${paramCount++}`);
      values.push(bio);
    }
    if (imageUrl !== undefined) {
      updates.push(`image_url = $${paramCount++}`);
      values.push(imageUrl);
    }
    if (genres !== undefined) {
      updates.push(`genres = $${paramCount++}`);
      values.push(genres);
    }
    if (verified !== undefined) {
      updates.push(`verified = $${paramCount++}`);
      values.push(verified);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(id);

    const result = await pool.query(
      `UPDATE artists SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update artist error:', error);
    res.status(500).json({ error: 'Failed to update artist' });
  }
});

// Add new album
router.post('/albums', async (req, res) => {
  try {
    const { title, artistId, releaseDate, albumType, genres, artworkUrl, explicit } = req.body;

    if (!title || !artistId) {
      return res.status(400).json({ error: 'Title and artist ID required' });
    }

    const result = await pool.query(
      `INSERT INTO albums (title, artist_id, release_date, album_type, genres, artwork_url, explicit)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, artistId, releaseDate, albumType || 'album', genres || [], artworkUrl || '', explicit || false]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Add album error:', error);
    res.status(500).json({ error: 'Failed to add album' });
  }
});

// Add new track
router.post('/tracks', async (req, res) => {
  try {
    const { title, artistId, albumId, durationMs, trackNumber, discNumber, explicit, audioFeatures, genres } = req.body;

    if (!title || !artistId || !albumId) {
      return res.status(400).json({ error: 'Title, artist ID, and album ID required' });
    }

    const result = await pool.query(
      `INSERT INTO tracks (title, artist_id, album_id, duration_ms, track_number, disc_number, explicit, audio_features)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [title, artistId, albumId, durationMs || 0, trackNumber || 1, discNumber || 1, explicit || false, audioFeatures || {}]
    );

    const track = result.rows[0];

    // Add genres
    if (genres && genres.length > 0) {
      for (const genre of genres) {
        await pool.query(
          'INSERT INTO track_genres (track_id, genre) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [track.id, genre]
        );
      }
    }

    res.status(201).json(track);
  } catch (error) {
    console.error('Add track error:', error);
    res.status(500).json({ error: 'Failed to add track' });
  }
});

// Create radio station
router.post('/radio-stations', async (req, res) => {
  try {
    const { name, description, type, seedArtistId, seedGenre, artworkUrl, trackIds } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Station name required' });
    }

    const result = await pool.query(
      `INSERT INTO radio_stations (name, description, type, seed_artist_id, seed_genre, artwork_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, description || '', type || 'curated', seedArtistId, seedGenre, artworkUrl || '']
    );

    const station = result.rows[0];

    // Add tracks if provided
    if (trackIds && trackIds.length > 0) {
      for (let i = 0; i < trackIds.length; i++) {
        await pool.query(
          'INSERT INTO radio_station_tracks (station_id, track_id, position) VALUES ($1, $2, $3)',
          [station.id, trackIds[i], i + 1]
        );
      }
    }

    // Invalidate cache
    await redis.del('radio:stations');

    res.status(201).json(station);
  } catch (error) {
    console.error('Create radio station error:', error);
    res.status(500).json({ error: 'Failed to create radio station' });
  }
});

// Clear cache
router.post('/cache/clear', async (req, res) => {
  try {
    const { pattern } = req.body;

    if (pattern) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      res.json({ message: `Cleared ${keys.length} keys matching ${pattern}` });
    } else {
      await redis.flushdb();
      res.json({ message: 'Cache cleared' });
    }
  } catch (error) {
    console.error('Clear cache error:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

export default router;
